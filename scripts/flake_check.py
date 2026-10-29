#!/usr/bin/env python3
"""Compare independent nextest reports without turning a failure green."""

import json
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


def mixed_tests(first: Path, second: Path) -> list[tuple[str, str]]:
    """Compare complete reports; missing, skipped and execution errors are not passes."""
    a, b = outcomes(first), outcomes(second)
    if a.keys() != b.keys():
        raise ValueError("the two runs did not report the same tests")
    if any(
        a[key] == "error" or b[key] == "error" or (a[key] == "skipped") != (b[key] == "skipped")
        for key in a
    ):
        raise ValueError("test execution or skip status is incomplete")
    return sorted(key for key in a if {a[key], b[key]} == {"passed", "failure"})


def run(command: list[str], log: Path) -> int | None:
    with log.open("w", encoding="utf-8") as stream:
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
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
    for number in (1, 2):
        baseline.append(
            run(
                ["cargo", "test", "--locked", "--all-targets", "--no-fail-fast", "--color", "never"],
                output / f"cargo-test-{number}.log",
            )
        )
        report = output / f"attempt-{number}.xml"
        config = output / f"attempt-{number}.toml"
        config.write_text(
            "[profile.ci.junit]\npath = "
            + json.dumps(str(report))
            + '\nstore-failure-output = false\n',
            encoding="utf-8",
        )
        attempts.append(
            run(
                [
                    "cargo",
                    "nextest",
                    "run",
                    "--locked",
                    "--all-targets",
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
            )
        )
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
        if any(code not in (0, 100) for code in attempts):
            raise ValueError("nextest did not complete both test runs")
        mixed = mixed_tests(output / "attempt-1.xml", output / "attempt-2.xml")
        for number, code in enumerate(attempts, 1):
            has_failures = "failure" in outcomes(output / f"attempt-{number}.xml").values()
            if has_failures != (code == 100):
                raise ValueError("nextest exit code does not match its report")
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"Cannot compare test results: {error}", file=sys.stderr)
        incomplete = True
        mixed = []
    baseline_differed = all(code is not None for code in baseline) and (baseline[0] == 0) != (
        baseline[1] == 0
    )
    docs_differed = all(code is not None for code in docs) and (docs[0] == 0) != (docs[1] == 0)
    summary = {
        "cargo_test_exit_codes": baseline,
        "cargo_test_inconsistent": baseline_differed,
        "exit_codes": attempts,
        "doctest_exit_codes": docs,
        "doctest_inconsistent": docs_differed,
        "mixed": mixed,
        "incomplete": incomplete,
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
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
