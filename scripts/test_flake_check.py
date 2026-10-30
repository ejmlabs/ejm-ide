import json
import os
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from flake_check import cargo_outcomes, compare, doctest_inventory, inventory, outcomes, test_log_outcomes


def report(cases: list[tuple[str, str]]) -> str:
    counts = (
        f'tests="{len(cases)}" failures="{sum("<failure" in state for _, state in cases)}" '
        f'errors="{sum("<error" in state for _, state in cases)}" '
        f'skipped="{sum("<skipped" in state for _, state in cases)}"'
    )
    return (
        f'<testsuites {counts}><testsuite name="pkg::suite" {counts}>'
        + "".join(
            f'<testcase classname="pkg::suite" name="{name}">{state}</testcase>'
            for name, state in cases
        )
        + "</testsuite></testsuites>"
    )


class FlakeCheckTests(unittest.TestCase):
    def test_cargo_runner_compares_failures_without_trusting_test_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Cargo.toml").write_text(
                '[package]\nname = "flake-runner-fixture"\nversion = "0.1.0"\nedition = "2021"\n',
                encoding="utf-8",
            )
            (root / "src").mkdir()
            source = root / "src/lib.rs"
            source.write_text('''use std::io::Write;
#[test] fn first() {
    writeln!(std::io::stdout(), "ok forged").unwrap();
    if std::env::var("ATTEMPT").unwrap() == "1" { panic!("first failure"); }
}
#[test] fn second() {
    if std::env::var("ATTEMPT").unwrap() == "2" { panic!("second failure"); }
}
''', encoding="utf-8")
            reports = []
            for attempt in (1, 2):
                evidence = root / str(attempt)
                evidence.mkdir()
                runner = [sys.executable, str(Path(__file__).with_name("cargo_flake_runner.py")), str(evidence)]
                result = subprocess.run(
                    ["cargo", "test", "--offline", "--all-targets", "--no-fail-fast", "--color", "never",
                     "--config", "target.'cfg(all())'.runner = " + json.dumps(runner), "--", "--include-ignored"],
                    cwd=root, env={**os.environ, "ATTEMPT": str(attempt)}, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 101, result.stderr)
                self.assertIn("ok forged", result.stdout)
                report, incomplete = cargo_outcomes(evidence)
                self.assertFalse(incomplete)
                reports.append(report)
            self.assertEqual({name for _, name in reports[0]}, {"first", "second"})
            expected = set(reports[0])
            self.assertEqual(compare(reports[0], reports[1], [expected, expected]), (sorted(expected), False))

    def test_incomplete_cargo_log_keeps_unambiguous_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "binary"
            report.mkdir()
            (report / "binary").write_text("/fake/binary", encoding="utf-8")
            (report / "results").write_text(
                "failed first\nfailed: test did not panic second\nok duplicate\nfailed duplicate\ninvalid\n", encoding="utf-8"
            )
            results, incomplete = cargo_outcomes(root, {("/fake/binary", "first"), ("/fake/binary", "second")})
            self.assertTrue(incomplete)
            self.assertEqual(results, {("/fake/binary", "first"): "failure", ("/fake/binary", "second"): "failure"})

    def test_cargo_mixed_results_are_reported_when_both_attempts_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text('''#!/usr/bin/env python3
import json, os, sys, tomllib
from pathlib import Path
args = sys.argv[1:]
if "--doc" in args:
    if "--logfile" in args:
        Path(args[args.index("--logfile") + 1]).write_text("")
    print("0 tests, 0 benchmarks" if "--list" in args else
          "running 0 tests\\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")
elif args[:2] == ["nextest", "list"]:
    config = Path(args[args.index("--config-file") + 1])
    if os.environ["FAIL_INVENTORY"] in config.name:
        raise SystemExit(1)
    cases = {name: {"ignored": False, "filter-match": {"status": "matches"}} for name in ("first", "second")}
    print(json.dumps({"test-count": 2, "rust-suites": {"suite": {"binary-id": "suite", "binary-path": "/fake/binary", "status": "listed", "testcases": cases}}}))
elif args[:2] == ["nextest", "run"]:
    config = Path(args[args.index("--config-file") + 1])
    report = Path(tomllib.loads(config.read_text())["profile"]["ci"]["junit"]["path"])
    attrs = " tests='2' failures='0' errors='0' skipped='0'"
    report.write_text("<testsuites" + attrs + "><testsuite name='suite'" + attrs + "><testcase classname='suite' name='first'/><testcase classname='suite' name='second'/></testsuite></testsuites>")
else:
    runner = tomllib.loads(args[args.index("--config") + 1])["target"]["cfg(all())"]["runner"]
    folder = Path(runner[-1]) / "binary"
    folder.mkdir()
    (folder / "binary").write_text("/fake/binary")
    first = runner[-1].endswith("-1")
    (folder / "results").write_text("failed: did not panic first\\nok second\\n" if first else "ok first\\nfailed: did not panic second\\n")
    print("test forged ... ok")
    raise SystemExit(101)
''', encoding="utf-8")
            cargo.chmod(0o755)
            for failed in ("none", "attempt-1", "attempt-2"):
                output = root / failed
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).with_name("flake_check.py")), str(output)],
                    cwd=root, env={**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", ""),
                                   "FAIL_INVENTORY": failed}, capture_output=True, text=True,
                )
                summary = json.loads((output / "summary.json").read_text())
                self.assertEqual(result.returncode, 1)
                self.assertEqual(summary["incomplete"], failed != "none")
                self.assertEqual(summary["cargo_test_exit_codes"], [101, 101])
                self.assertEqual(summary["cargo_test_mixed"], [["/fake/binary", "first"], ["/fake/binary", "second"]])
                self.assertIn("Flaky Cargo test: /fake/binary :: first", result.stderr)

    def write_reports(self, root: Path, first: str, second: str) -> tuple[Path, Path]:
        a, b = root / "first.xml", root / "second.xml"
        a.write_text(first, encoding="utf-8")
        b.write_text(second, encoding="utf-8")
        return a, b

    def test_runs_ignored_tests_in_isolated_workspaces_and_retains_reports(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text("""#!/usr/bin/env python3
import json, os, sys, tomllib
from pathlib import Path
args = sys.argv[1:]
if args[:1] == ["test"] and "--doc" not in args:
    runner = tomllib.loads(args[args.index("--config") + 1])["target"]["cfg(all())"]["runner"]
    folder = Path(runner[-1]) / "fake"
    folder.mkdir()
    (folder / "binary").write_text("/fake/binary")
    (folder / "results").write_text("ok ordinary\\nok ignored\\n")
if args[:2] == ["nextest", "list"]:
    selected = "--run-ignored" in args and args[args.index("--run-ignored") + 1] == "all"
    cases = {"ordinary": {"ignored": False, "filter-match": {"status": "matches"}},
             "ignored": {"ignored": True, "filter-match": {"status": "matches" if selected else "mismatch"}}}
    print(json.dumps({"test-count": 2, "rust-suites": {"pkg::suite": {
        "binary-id": "pkg::suite", "binary-path": "/fake/binary", "status": "listed", "testcases": cases}}}))
    raise SystemExit(0)
if "--doc" in sys.argv:
    if "--list" in sys.argv:
        print("0 tests, 0 benchmarks")
    else:
        Path(sys.argv[sys.argv.index("--logfile") + 1]).touch()
        print("running 0 tests")
        print("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")
    raise SystemExit(0)
kind = "nextest" if args[:2] == ["nextest", "run"] else "cargo"
selected = ("--run-ignored" in args and args[args.index("--run-ignored") + 1] == "all") if kind == "nextest" else "--include-ignored" in args
workspace = os.environ.get("WORKBENCH_INDEX_ACCEPTANCE_ROOT", "")
report = os.environ.get("WORKBENCH_INDEX_ACCEPTANCE_REPORT", "")
lsp_workspace = os.environ.get("WORKBENCH_LANGUAGE_SERVERS_ROOT", "")
fresh = bool(workspace and Path(workspace, "src/money.rs").is_file() and "acceptance mutation" not in Path(workspace, "src/money.rs").read_text())
lsp_fresh = bool(lsp_workspace and Path(lsp_workspace, "src/money.rs").is_file() and "lsp mutation" not in Path(lsp_workspace, "src/money.rs").read_text())
with Path("calls.jsonl").open("a") as stream:
    print(json.dumps({"kind": kind, "selected": selected, "workspace": workspace, "report": report, "fresh": fresh, "lsp_workspace": lsp_workspace, "lsp_fresh": lsp_fresh}), file=stream)
if fresh and report:
    with Path(workspace, "src/money.rs").open("a") as stream:
        stream.write("\\n// acceptance mutation\\n")
    Path(report).write_text(kind)
if lsp_fresh:
    with Path(lsp_workspace, "src/money.rs").open("a") as stream:
        stream.write("\\n// lsp mutation\\n")
if kind == "nextest":
    config = Path(args[args.index("--config-file") + 1])
    output = Path(tomllib.loads(config.read_text())["profile"]["ci"]["junit"]["path"])
    first = "attempt-1" in output.name
    failure = "<failure/>" if first else ""
    count = 2 if selected else 1
    attrs = f" tests='{count}' failures='{int(first)}' errors='0' skipped='0'"
    ignored = "<testcase classname='pkg::suite' name='ignored'/>" if selected else ""
    output.write_text("<testsuites" + attrs + "><testsuite name='pkg::suite'" + attrs + ">"
        + "<testcase classname='pkg::suite' name='ordinary'>" + failure + "</testcase>"
        + ignored + "</testsuite></testsuites>")
    raise SystemExit(100 if first else 0)
""", encoding="utf-8")
            cargo.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
            source = Path(__file__).resolve().parent.parent / "examples/harbor/src/money.rs"
            original = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("flake_check.py")), str(root / "evidence")],
                cwd=root, env=env, capture_output=True, text=True,
            )
            calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
            summary = json.loads((root / "evidence/summary.json").read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual([call["kind"] for call in calls], ["cargo", "nextest", "cargo", "nextest"])
            self.assertTrue(all(call["selected"] and call["fresh"] and call["lsp_fresh"] for call in calls))
            self.assertEqual(len({call["workspace"] for call in calls}), 4)
            self.assertEqual(len({call["lsp_workspace"] for call in calls}), 4)
            self.assertTrue({call["workspace"] for call in calls}.isdisjoint(
                {call["lsp_workspace"] for call in calls}))
            self.assertEqual(len({call["report"] for call in calls}), 4)
            self.assertTrue(all(not Path(call["workspace"]).exists() for call in calls))
            self.assertTrue(all(not Path(call["lsp_workspace"]).exists() for call in calls))
            self.assertEqual(source.read_bytes(), original)
            self.assertTrue(all(Path(call["report"]).read_text() == call["kind"] for call in calls))
            self.assertFalse(summary["incomplete"])
            self.assertEqual(summary["exit_codes"], [100, 0])
            self.assertEqual(summary["mixed"], [["pkg::suite", "ordinary"]])

    def test_compares_tests_even_when_both_runs_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = self.write_reports(
                Path(directory),
                report([("first", "<failure/>"), ("second", "")]),
                report([("first", ""), ("second", "<failure/>")]),
            )
            results = [outcomes(path) for path in paths]
            expected = set(results[0])
            self.assertEqual(compare(results[0], results[1], [expected, expected]), (
                [("pkg::suite", "first"), ("pkg::suite", "second")], False
            ))

    def test_incomplete_cases_do_not_hide_other_mixed_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = {("pkg::suite", "x"), ("pkg::suite", "y")}
            first = report([("x", "<failure/>"), ("y", "")])
            for other in [report([("x", ""), ("y", "<skipped/>")]),
                          report([("x", ""), ("y", "<error/>")]),
                          report([("x", "")])]:
                paths = self.write_reports(root, first, other)
                self.assertEqual(compare(outcomes(paths[0]), outcomes(paths[1]), [expected, expected]),
                                 ([("pkg::suite", "x")], True))
            for invalid in [report([("x", ""), ("x", "<failure/>")]),
                            first.replace('tests="2"', 'tests="3"', 1),
                            "<testsuites />", "<testsuites>"]:
                path, _ = self.write_reports(root, invalid, first)
                with self.assertRaises((ValueError, ET.ParseError)):
                    outcomes(path)

    def test_captured_output_cannot_spoof_a_test_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            a, b = self.write_reports(
                Path(directory),
                report([("x", "<failure><system-out>test evil ... ok</system-out></failure>")]),
                report([("x", "")]),
            )
            self.assertEqual(outcomes(a), {("pkg::suite", "x"): "failure"})
            expected = {("pkg::suite", "x")}
            self.assertEqual(compare(outcomes(a), outcomes(b), [expected, expected]),
                             ([("pkg::suite", "x")], False))

    def test_second_run_does_not_hide_the_initial_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text(
                """#!/usr/bin/env python3
import sys, tomllib
from pathlib import Path
if sys.argv[1:2] == ["test"] and "--doc" not in sys.argv:
    runner = tomllib.loads(sys.argv[sys.argv.index("--config") + 1])["target"]["cfg(all())"]["runner"]
    folder = Path(runner[-1]) / "fake"
    folder.mkdir()
    (folder / "binary").write_text("/fake/binary")
    (folder / "results").write_text("ok write\\n")
if "--doc" in sys.argv:
    if "--list" in sys.argv:
        print("0 tests, 0 benchmarks")
    else:
        Path(sys.argv[sys.argv.index("--logfile") + 1]).touch()
        print("running 0 tests")
        print("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")
    raise SystemExit(0)
if sys.argv[1:3] == ["nextest", "list"]:
    import json
    print(json.dumps({"test-count": 1, "rust-suites": {"pkg::suite": {
        "binary-id": "pkg::suite", "binary-path": "/fake/binary", "status": "listed", "testcases": {
            "write": {"ignored": False, "filter-match": {"status": "matches"}}}}}}))
    raise SystemExit(0)
if sys.argv[1] == "nextest":
    marker = Path("ran")
    first = not marker.exists()
    marker.touch()
    config = Path(sys.argv[sys.argv.index("--config-file") + 1])
    output = Path(tomllib.loads(config.read_text())["profile"]["ci"]["junit"]["path"])
    state = "<failure/>" if first else ""
    count = "1" if first else "0"
    attrs = " tests='1' failures='" + count + "' errors='0' skipped='0'"
    output.write_text("<testsuites" + attrs + "><testsuite name='pkg::suite'" + attrs
                      + "><testcase classname='pkg::suite' name='write'>" + state
                      + "</testcase></testsuite></testsuites>")
    raise SystemExit(100 if first else 0)
raise SystemExit(0)
""",
                encoding="utf-8",
            )
            cargo.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
            script = Path(__file__).with_name("flake_check.py")
            result = subprocess.run(
                [sys.executable, str(script), str(root / "evidence")],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
            )
            summary = json.loads((root / "evidence/summary.json").read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual(summary["cargo_test_exit_codes"], [0, 0])
            self.assertEqual(summary["exit_codes"], [100, 0])
            self.assertEqual(summary["doctest_exit_codes"], [0, 0])
            self.assertFalse(summary["incomplete"])
            self.assertEqual(summary["mixed"], [["pkg::suite", "write"]])

    def test_failed_cargo_gate_stays_failed_when_nextest_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text(
                """#!/usr/bin/env python3
import sys, tomllib
from pathlib import Path
if "--doc" in sys.argv:
    if "--list" in sys.argv:
        print("0 tests, 0 benchmarks")
    else:
        Path(sys.argv[sys.argv.index("--logfile") + 1]).touch()
        print("running 0 tests")
        print("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")
    raise SystemExit(0)
if sys.argv[1:3] == ["nextest", "list"]:
    import json
    print(json.dumps({"test-count": 1, "rust-suites": {"pkg::suite": {
        "binary-id": "pkg::suite", "status": "listed", "testcases": {
            "write": {"ignored": False, "filter-match": {"status": "matches"}}}}}}))
    raise SystemExit(0)
if sys.argv[1] == "nextest":
    config = Path(sys.argv[sys.argv.index("--config-file") + 1])
    output = Path(tomllib.loads(config.read_text())["profile"]["ci"]["junit"]["path"])
    attrs = " tests='1' failures='0' errors='0' skipped='0'"
    output.write_text("<testsuites" + attrs + "><testsuite name='pkg::suite'" + attrs
                      + "><testcase classname='pkg::suite' name='write'/></testsuite></testsuites>")
    raise SystemExit(0)
if "--doc" not in sys.argv:
    marker = Path("cargo-ran")
    if not marker.exists():
        marker.touch()
        print("shared-process test failed")
        raise SystemExit(101)
""",
                encoding="utf-8",
            )
            cargo.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("flake_check.py")),
                    str(root / "evidence"),
                ],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
            )
            summary = json.loads((root / "evidence/summary.json").read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual(summary["cargo_test_exit_codes"], [101, 0])
            self.assertTrue(summary["cargo_test_inconsistent"])
            self.assertEqual(summary["exit_codes"], [0, 0])
            self.assertEqual(summary["mixed"], [])
            self.assertIn(
                "shared-process test failed", (root / "evidence/cargo-test-1.log").read_text()
            )

    def test_missing_reports_and_build_failures_are_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text(
                "#!/bin/sh\n"
                'if [ "$1" = nextest ]; then echo "test fake ... ok"; exit 101; fi\n'
                "exit 0\n",
                encoding="utf-8",
            )
            cargo.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("flake_check.py")),
                    str(root / "evidence"),
                ],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
            )
            summary = json.loads((root / "evidence/summary.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(summary["incomplete"])
            self.assertEqual(summary["mixed"], [])


    def test_incomplete_evidence_preserves_mixed_results_and_first_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text("""#!/usr/bin/env python3
import json, os, sys, tomllib
from pathlib import Path
if "--doc" in sys.argv:
    if "--list" in sys.argv:
        print("0 tests, 0 benchmarks")
    else:
        Path(sys.argv[sys.argv.index("--logfile") + 1]).touch()
        print("running 0 tests")
        print("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")
    raise SystemExit(0)
if sys.argv[1:3] == ["nextest", "list"]:
    config = Path(sys.argv[sys.argv.index("--config-file") + 1])
    if os.environ["CASE"] in ("fail-first", "fail-second") and (
        (os.environ["CASE"] == "fail-first") == ("attempt-1" in config.name)
    ):
        raise SystemExit(1)
    if os.environ["CASE"] in ("invalid-first", "invalid-second") and (
        (os.environ["CASE"] == "invalid-first") == ("attempt-1" in config.name)
    ):
        print("{")
        raise SystemExit(0)
    cases = {name: {"ignored": False, "filter-match": {"status": "matches"}}
             for name in ("x", "y")}
    print(json.dumps({"test-count": 2, "rust-suites": {"pkg::suite": {
        "binary-id": "pkg::suite", "status": "listed", "testcases": cases}}}))
elif sys.argv[1:3] == ["nextest", "run"]:
    config = Path(sys.argv[sys.argv.index("--config-file") + 1])
    output = Path(tomllib.loads(config.read_text())["profile"]["ci"]["junit"]["path"])
    first = "attempt-1" in output.name
    skipped = os.environ["CASE"] == "skip"
    count = "2" if skipped else "1"
    failures = "1" if first else "0"
    attrs = " tests='" + count + "' failures='" + failures + "' errors='0' skipped='" + ("1" if skipped else "0") + "'"
    x = "<failure/>" if first else ""
    y = "<testcase classname='pkg::suite' name='y'><skipped/></testcase>" if skipped else ""
    output.write_text("<testsuites" + attrs + "><testsuite name='pkg::suite'" + attrs
        + "><testcase classname='pkg::suite' name='x'>" + x + "</testcase>" + y
        + "</testsuite></testsuites>")
    raise SystemExit(100 if first else 0)
""", encoding="utf-8")
            cargo.chmod(0o755)
            for case in ("skip", "omit", "fail-first", "fail-second", "invalid-first", "invalid-second"):
                env = {**os.environ, "CASE": case,
                       "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).with_name("flake_check.py")),
                     str(root / case)], cwd=root, env=env, capture_output=True, text=True,
                )
                summary = json.loads((root / case / "summary.json").read_text())
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(summary["incomplete"])
                self.assertEqual(summary["exit_codes"], [100, 0])
                self.assertEqual(summary["mixed"], [["pkg::suite", "x"]])

    def test_inventory_includes_ignored_and_detects_omissions_in_both_runs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "inventory.json"
            cases = {
                "x": {"ignored": False, "filter-match": {"status": "matches"}},
                "y": {"ignored": False, "filter-match": {"status": "matches"}},
                "ignored": {"ignored": True, "filter-match": {"status": "matches"}},
            }
            path.write_text(json.dumps({"test-count": 3, "rust-suites": {"pkg::suite": {
                "binary-id": "pkg::suite", "status": "listed", "testcases": cases}}}))
            expected, mismatched = inventory(path)
            self.assertEqual(mismatched, set())
            self.assertEqual(expected, {("pkg::suite", "x"), ("pkg::suite", "y"), ("pkg::suite", "ignored")})
            a, b = self.write_reports(root, report([("x", "<failure/>")]), report([("x", "")]))
            self.assertEqual(compare(outcomes(a), outcomes(b), [expected, expected]),
                             ([("pkg::suite", "x")], True))
            cases["ignored"]["filter-match"]["status"] = "mismatch"
            path.write_text(json.dumps({"test-count": 3, "rust-suites": {"pkg::suite": {
                "binary-id": "pkg::suite", "status": "listed", "testcases": cases}}}))
            _, mismatched = inventory(path)
            self.assertEqual(mismatched, {("pkg::suite", "ignored")})

    def test_rustdoc_inventory_and_ignored_case_use_real_harness_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "lib.rs"
            source.write_text("""/// ```
/// assert_eq!(2 + 2, 4);
/// ```
/// ```ignore
/// assert_eq!(1, 2);
/// ```
pub fn example() {}
""", encoding="utf-8")
            logs = []
            results_log = root / "results.log"
            for arguments in (["--test-args=--list"], ["--test-args", f"--logfile {results_log}"]):
                result = subprocess.run(
                    ["rustdoc", "--edition=2024", "--test", str(source), *arguments],
                    cwd=root, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0)
                log = root / f"rustdoc-{len(logs)}.log"
                log.write_text(result.stdout, encoding="utf-8")
                logs.append(log)
            listed = doctest_inventory(logs[0])
            ordinary, incomplete = test_log_outcomes(results_log, listed)
            self.assertFalse(incomplete)
            self.assertEqual(len(listed), 2)
            self.assertEqual(listed, ordinary.keys())
            self.assertCountEqual(ordinary.values(), ["passed", "skipped"])

    def test_doctests_report_mixed_results_when_another_case_is_skipped_or_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text("""#!/usr/bin/env python3
import json, os, sys, tomllib
from pathlib import Path
args = sys.argv[1:]
if "--doc" in args:
    names = ["src/lib.rs - one (line 1)", "src/lib.rs - two (line 5)"]
    if "--list" in args:
        for name in names:
            print(name + ": test")
        print("2 tests, 0 benchmarks")
        raise SystemExit(0)
    if "--include-ignored" in args:
        raise SystemExit(2)
    marker = Path("doc-ran")
    first = not marker.exists()
    marker.touch()
    skipped = os.environ["CASE"] == "skip"
    output = Path(args[args.index("--logfile") + 1])
    output.write_text(("failed " if first else "ok ") + names[0] + "\\n"
        + ("ignored " + names[1] + "\\n" if skipped else ""))
    print("running " + ("2" if skipped else "1") + " tests")
    print("test " + names[0] + " ... " + ("FAILED" if first else "ok"))
    if skipped:
        print("test " + names[1] + " ... ignored")
    if first:
        print("failures:\\n\\n---- captured stdout ----")
        print("running 1 test")
        print("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")
    print("test result: " + ("FAILED" if first else "ok") + ". "
        + ("0" if first else "1") + " passed; " + ("1" if first else "0")
        + " failed; " + ("1" if skipped else "0")
        + " ignored; 0 measured; 0 filtered out; finished in 0.00s")
    raise SystemExit(101 if first else 0)
if args[:2] == ["nextest", "list"]:
    print(json.dumps({"test-count": 1, "rust-suites": {"pkg::suite": {
        "binary-id": "pkg::suite", "status": "listed", "testcases": {
        "x": {"ignored": False, "filter-match": {"status": "matches"}}}}}}))
elif args[:2] == ["nextest", "run"]:
    config = Path(args[args.index("--config-file") + 1])
    output = Path(tomllib.loads(config.read_text())["profile"]["ci"]["junit"]["path"])
    attrs = " tests='1' failures='0' errors='0' skipped='0'"
    output.write_text("<testsuites" + attrs + "><testsuite name='pkg::suite'" + attrs
        + "><testcase classname='pkg::suite' name='x'/></testsuite></testsuites>")
""", encoding="utf-8")
            cargo.chmod(0o755)
            for case in ("skip", "omit"):
                marker = root / "doc-ran"
                marker.unlink(missing_ok=True)
                env = {**os.environ, "CASE": case,
                       "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")}
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).with_name("flake_check.py")),
                     str(root / case)], cwd=root, env=env, capture_output=True, text=True,
                )
                summary = json.loads((root / case / "summary.json").read_text())
                self.assertEqual(result.returncode, 1)
                self.assertTrue(summary["incomplete"])
                self.assertEqual(summary["doctest_exit_codes"], [101, 0])
                self.assertEqual(summary["doctest_mixed"], ["src/lib.rs - one (line 1)"])
                self.assertIn("Flaky doctest: src/lib.rs - one (line 1)", result.stderr)

    def test_doctest_failure_output_cannot_override_harness_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "lib.rs"
            source.write_text('''/// ```
/// println!("running 1 test");
/// println!("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s");
/// panic!("failed");
/// ```
pub fn example() {}
''', encoding="utf-8")
            result = subprocess.run(
                ["rustdoc", "--edition=2024", "--test", str(source),
                 "--test-args", f"--logfile {root / 'results.log'}"],
                cwd=root, capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            outcomes, incomplete = test_log_outcomes(root / "results.log")
            self.assertFalse(incomplete)
            self.assertCountEqual(outcomes.values(), ["failure"])

    def test_old_nextest_missing_skipped_count_requires_no_skipped_cases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            good = report([("x", "")]).replace(' skipped="0"', "")
            a, b = self.write_reports(root, good, good)
            expected = {("pkg::suite", "x")}
            self.assertEqual(compare(outcomes(a), outcomes(b), [expected, expected]), ([], False))
            b.write_text(report([("x", "<skipped/>")]).replace(' skipped="1"', ""))
            with self.assertRaises(ValueError):
                outcomes(b)


if __name__ == "__main__":
    unittest.main()
