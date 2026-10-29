#!/usr/bin/env python3
"""Compare independent nextest reports without turning a failure green."""

import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Iterable
from pathlib import Path


def outcomes(path: Path) -> dict[tuple[str, str], str]:
    """Return per-test results from a complete nextest JUnit report."""
    # shortcut: Reports over 50 MiB are refused; raise this bound if suites exceed it.
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("test report exceeds 50 MiB")
    root = ET.parse(path).getroot()
    if root.tag != "testsuites":
        raise ValueError("not a nextest JUnit report")
    results = {}
    for suite in root.findall("testsuite"):
        suite_name = suite.get("name")
        if not suite_name:
            raise ValueError("test suite has no name")
        suite_results = []
        for case in suite.findall("testcase"):
            name = case.get("name")
            if not name or case.get("classname") != suite_name:
                raise ValueError("test case has no matching identity")
            key = (suite_name, name)
            if key in results:
                raise ValueError(f"duplicate test result: {key}")
            states = [child.tag for child in case if child.tag in ("failure", "error", "skipped")]
            if len(states) > 1 or any(child.tag.startswith(("flaky", "rerun")) for child in case):
                raise ValueError(f"ambiguous test result: {key}")
            status = states[0] if states else "passed"
            results[key] = status
            suite_results.append(status)
        check_counts(suite, suite_results)
    if not results:
        raise ValueError("report contains no tests")
    check_counts(root, results.values())
    return results


def check_counts(element: ET.Element, statuses: Iterable[str]) -> None:
    counts = Counter(statuses)
    expected = {
        "tests": sum(counts.values()),
        "failures": counts["failure"],
        "errors": counts["error"],
        "skipped": counts["skipped"],
    }
    for key, value in expected.items():
        # Older nextest omits the skipped count when it emits no skipped cases.
        if key == "skipped" and key not in element.attrib and value == 0:
            continue
        try:
            actual = int(element.attrib[key])
        except (KeyError, ValueError) as error:
            raise ValueError(f"missing or invalid {key} count") from error
        if actual != value:
            raise ValueError(f"{key} count does not match reported tests")


def inventory(path: Path) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("test inventory exceeds 50 MiB")
    data = json.loads(path.read_text(encoding="utf-8"))
    try:
        suites = data["rust-suites"]
        if not isinstance(suites, dict):
            raise ValueError("invalid test suites")
        selected = set()
        mismatched = set()
        total = 0
        for suite_name, suite in suites.items():
            if not suite_name or suite["binary-id"] != suite_name or suite["status"] != "listed":
                raise ValueError("invalid test suite identity or status")
            cases = suite["testcases"]
            if not isinstance(cases, dict):
                raise ValueError("invalid test cases")
            for name, case in cases.items():
                if not name or not isinstance(case["ignored"], bool):
                    raise ValueError("invalid test identity or ignore status")
                match = case["filter-match"]["status"]
                if (match, case["ignored"]) not in (("matches", False), ("matches", True), ("mismatch", True)):
                    raise ValueError("unexpected test filter status")
                selected.add((suite_name, name))
                if match == "mismatch":
                    mismatched.add((suite_name, name))
                total += 1
        if data["test-count"] != total or not selected:
            raise ValueError("test inventory is empty or has an invalid count")
        return selected, mismatched
    except (KeyError, TypeError) as error:
        raise ValueError("invalid test inventory") from error


def compare(
    first: dict[tuple[str, str], str],
    second: dict[tuple[str, str], str],
    inventories: list[set[tuple[str, str]]],
) -> tuple[list[tuple[str, str]], bool]:
    selected = inventories[0] & inventories[1]
    mixed = sorted(
        key for key in selected & first.keys() & second.keys()
        if {first[key], second[key]} == {"passed", "failure"}
    )
    incomplete = (
        inventories[0] != inventories[1]
        or first.keys() != inventories[0]
        or second.keys() != inventories[1]
        or any(status in ("skipped", "error") for status in (*first.values(), *second.values()))
    )
    return mixed, incomplete


def run(command: list[str], log: Path, env: dict[str, str] | None = None) -> int | None:
    with log.open("w", encoding="utf-8") as stream:
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
        except OSError as error:
            print(f"Could not start {command[0]}: {error}", file=stream)
            return None
        assert process.stdout is not None
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            stream.write(line)
        return process.wait()


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/flake_check.py OUTPUT_DIRECTORY")
    output = Path(sys.argv[1]).resolve()
    output.mkdir()
    baseline = []
    attempts = []
    docs = []
    inventory_codes = []
    harbor = Path(__file__).resolve().parent.parent / "examples" / "harbor"
    for number in (1, 2):
        cargo_workspace = output / f"workspace-cargo-{number}"
        cargo_lsp_workspace = output / f"workspace-lsp-cargo-{number}"
        shutil.copytree(harbor, cargo_workspace)
        shutil.copytree(harbor, cargo_lsp_workspace)
        baseline.append(
            run(
                ["cargo", "test", "--locked", "--all-targets", "--no-fail-fast", "--color", "never", "--", "--include-ignored"],
                output / f"cargo-test-{number}.log",
                {**os.environ, "WORKBENCH_INDEX_ACCEPTANCE_ROOT": str(cargo_workspace),
                 "WORKBENCH_LANGUAGE_SERVERS_ROOT": str(cargo_lsp_workspace),
                 "WORKBENCH_INDEX_ACCEPTANCE_REPORT": str(output / f"acceptance-cargo-{number}.json")},
            )
        )
        shutil.rmtree(cargo_workspace)
        shutil.rmtree(cargo_lsp_workspace)
        report = output / f"attempt-{number}.xml"
        config = output / f"attempt-{number}.toml"
        config.write_text(
            "[profile.ci.junit]\npath = "
            + json.dumps(str(report))
            + '\nstore-failure-output = false\n',
            encoding="utf-8",
        )
        inventory_path = output / f"inventory-{number}.json"
        with inventory_path.open("w", encoding="utf-8") as stream:
            try:
                inventory_codes.append(subprocess.run(
                    ["cargo", "nextest", "list", "--locked", "--all-targets", "--run-ignored", "all", "--color", "never",
                     "--profile", "ci", "--config-file", str(config), "--user-config-file", "none",
                     "--message-format", "json"],
                    stdout=stream,
                ).returncode)
            except OSError as error:
                print(f"Could not list tests: {error}", file=sys.stderr)
                inventory_codes.append(None)
        nextest_workspace = output / f"workspace-nextest-{number}"
        nextest_lsp_workspace = output / f"workspace-lsp-nextest-{number}"
        shutil.copytree(harbor, nextest_workspace)
        shutil.copytree(harbor, nextest_lsp_workspace)
        attempts.append(
            run(
                [
                    "cargo",
                    "nextest",
                    "run",
                    "--locked",
                    "--all-targets",
                    "--run-ignored",
                    "all",
                    "--no-fail-fast",
                    "--retries",
                    "0",
                    "--color",
                    "never",
                    "--profile",
                    "ci",
                    "--config-file",
                    str(config),
                    "--user-config-file",
                    "none",
                    "--no-tests",
                    "fail",
                ],
                output / f"attempt-{number}.log",
                {**os.environ, "WORKBENCH_INDEX_ACCEPTANCE_ROOT": str(nextest_workspace),
                 "WORKBENCH_LANGUAGE_SERVERS_ROOT": str(nextest_lsp_workspace),
                 "WORKBENCH_INDEX_ACCEPTANCE_REPORT": str(output / f"acceptance-nextest-{number}.json")},
            )
        )
        shutil.rmtree(nextest_workspace)
        shutil.rmtree(nextest_lsp_workspace)
        # nextest does not run doctests; keep their logs and exit codes separately.
        docs.append(
            run(
                ["cargo", "test", "--locked", "--doc", "--color", "never"],
                output / f"doctest-{number}.log",
            )
        )
    incomplete = (
        any(code is None for code in baseline)
        or any(code not in (0, 100) for code in attempts)
        or any(code is None for code in docs)
    )
    mixed = []
    try:
        if any(code != 0 for code in inventory_codes):
            raise ValueError("nextest did not complete both inventories")
        listed = [inventory(output / f"inventory-{number}.json") for number in (1, 2)]
        inventories = [selected for selected, _ in listed]
        incomplete |= any(mismatched for _, mismatched in listed)
        reports = [outcomes(output / f"attempt-{number}.xml") for number in (1, 2)]
        mixed, comparison_incomplete = compare(*reports, inventories)
        mismatched = listed[0][1] | listed[1][1]
        mixed = [key for key in mixed if key not in mismatched]
        incomplete |= comparison_incomplete
        for code, results in zip(attempts, reports):
            has_failures = "failure" in results.values()
            if code not in (0, 100) or has_failures != (code == 100):
                incomplete = True
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"Cannot compare test results: {error}", file=sys.stderr)
        incomplete = True
    baseline_differed = all(code is not None for code in baseline) and (baseline[0] == 0) != (
        baseline[1] == 0
    )
    docs_differed = all(code is not None for code in docs) and (docs[0] == 0) != (docs[1] == 0)
    summary = {
        "cargo_test_exit_codes": baseline,
        "cargo_test_inconsistent": baseline_differed,
        "inventory_exit_codes": inventory_codes,
        "exit_codes": attempts,
        "doctest_exit_codes": docs,
        "doctest_inconsistent": docs_differed,
        "mixed": mixed,
        "incomplete": incomplete,
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    if incomplete:
        print("Test evidence is incomplete; inspect inventories and reports.", file=sys.stderr)
    for suite, name in mixed:
        print(f"Flaky test: {suite} :: {name}", file=sys.stderr)
    if baseline_differed:
        print("Cargo test suite outcomes differed; inspect cargo-test logs.", file=sys.stderr)
    if docs_differed:
        print("Doctest suite outcomes differed; inspect doctest logs.", file=sys.stderr)
    print(f"Test evidence: {output}")
    return int(incomplete or any(code != 0 for code in baseline + attempts + docs))


if __name__ == "__main__":
    sys.exit(main())
