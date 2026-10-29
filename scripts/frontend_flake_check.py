#!/usr/bin/env python3
"""Compare independent Vitest runs against a collected test inventory."""

import json
import os
import sys
from collections import Counter
from pathlib import Path

from flake_check import run


def read_json(path: Path) -> object:
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("test evidence exceeds 50 MiB")
    return json.loads(path.read_text(encoding="utf-8"))


def inventory(path: Path) -> tuple[Counter[tuple[str, str]], bool]:
    entries = read_json(path)
    if not isinstance(entries, list) or not entries:
        raise ValueError("test inventory is empty or invalid")
    result = Counter()
    skipped = False
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("file"), str) or not isinstance(entry.get("name"), str) or not entry["file"] or not entry["name"] or entry.get("projectName"):
            raise ValueError("invalid test inventory identity")
        key = (entry["file"], entry["name"])
        result[key] += 1
        if not isinstance(entry.get("skipped"), bool):
            raise ValueError("missing inventory skip status")
        skipped |= entry["skipped"]
    return result, skipped


def outcomes(path: Path) -> dict[tuple[str, tuple[str, ...]], list[str]]:
    report = read_json(path)
    if not isinstance(report, dict) or not isinstance(report.get("testResults"), list):
        raise ValueError("invalid Vitest report")
    results = {}
    counts = Counter()
    for suite in report["testResults"]:
        if not isinstance(suite, dict) or not isinstance(suite.get("name"), str) or not suite["name"] or not isinstance(suite.get("assertionResults"), list):
            raise ValueError("invalid test suite")
        for case in suite["assertionResults"]:
            if not isinstance(case, dict) or not isinstance(case.get("ancestorTitles"), list) or not all(isinstance(title, str) for title in case["ancestorTitles"]) or not isinstance(case.get("title"), str) or not case["title"] or case.get("status") not in ("passed", "failed", "skipped", "pending", "todo", "disabled"):
                raise ValueError("invalid test result")
            key = (suite["name"], (*case["ancestorTitles"], case["title"]))
            results.setdefault(key, []).append(case["status"])
            counts[case["status"]] += 1
    if not results or report.get("numTotalTests") != sum(counts.values()) or report.get("numPassedTests") != counts["passed"] or report.get("numFailedTests") != counts["failed"]:
        raise ValueError("test counts do not match report")
    return results


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/frontend_flake_check.py OUTPUT_DIRECTORY")
    output = Path(sys.argv[1]).resolve()
    output.mkdir()
    inventory_code = run(["node", "scripts/frontend_flake_inventory.mjs", str(output / "inventory.json")], output / "inventory.log")
    codes = []
    for number in (1, 2):
        os.environ["EJM_TEST_REPORT"] = str(output / f"attempt-{number}.json")
        codes.append(run(["npm", "test"], output / f"attempt-{number}.log"))
    incomplete = inventory_code != 0 or any(code not in (0, 1) for code in codes)
    mixed = []
    expected = None
    try:
        expected, skipped = inventory(output / "inventory.json")
        incomplete |= skipped
    except (OSError, ValueError, TypeError) as error:
        print(f"Cannot read frontend test inventory: {error}", file=sys.stderr)
        incomplete = True
    try:
        first, second = (outcomes(output / f"attempt-{number}.json") for number in (1, 2))
        if first.keys() != second.keys():
            incomplete = True
        projected_runs = []
        for code, results in zip(codes, (first, second), strict=True):
            projected = Counter()
            for (file, titles), statuses in results.items():
                projected[(file, " > ".join(titles))] += len(statuses)
            projected_runs.append(projected)
            if expected is None or projected != expected or any(count != 1 for count in projected.values()) or any(count != 1 for count in expected.values()) or any(status not in ("passed", "failed") for statuses in results.values() for status in statuses):
                incomplete = True
            if any("failed" in statuses for statuses in results.values()) != (code == 1):
                incomplete = True
        mixed = sorted(
            key for key in first.keys() & second.keys()
            if (expected is None or expected[(key[0], " > ".join(key[1]))] <= 1)
            and all(projected[(key[0], " > ".join(key[1]))] == 1 for projected in projected_runs)
            and {first[key][0], second[key][0]} == {"passed", "failed"}
        )
    except (OSError, ValueError, TypeError) as error:
        print(f"Cannot compare frontend test results: {error}", file=sys.stderr)
        incomplete = True
    summary = {"inventory_exit_code": inventory_code, "exit_codes": codes, "mixed": mixed, "incomplete": incomplete}
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    for file, titles in mixed:
        print(f"Flaky test: {file} :: {' > '.join(titles)}", file=sys.stderr)
    if incomplete:
        print("Frontend test evidence is incomplete; inspect reports and logs.", file=sys.stderr)
    print(f"Test evidence: {output}")
    return int(incomplete or any(code != 0 for code in codes))


if __name__ == "__main__":
    sys.exit(main())
