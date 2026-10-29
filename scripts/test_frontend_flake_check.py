import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class FrontendFlakeCheckTests(unittest.TestCase):
    def test_actual_collector_includes_skipped_and_parameterized_cases(self) -> None:
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
            shutil.copy(source / "scripts/frontend_flake_inventory.mjs", root / "collector.mjs")
            (root / "sample.test.mjs").write_text(
                "import { describe, test } from 'vitest'; "
                "describe('outer', () => { test.each([1, 2])('case %s', () => {}); "
                "test.skip('ignored', () => {}); });\n"
            )
            result = subprocess.run(["node", "collector.mjs", "inventory.json"], cwd=root,
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            cases = json.loads((root / "inventory.json").read_text())
            self.assertEqual({(case["name"], case["skipped"]) for case in cases},
                             {("outer > case 1", False), ("outer > case 2", False), ("outer > ignored", True)})

    def check(self, first: list[dict], second: list[dict], inventory: list[dict], codes: list[int]) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node = root / "node"
            node.write_text("""#!/usr/bin/env python3
import json, sys
from pathlib import Path
fixture = json.loads(Path('fixture.json').read_text())
Path(sys.argv[-1]).write_text(json.dumps([{**case, 'skipped': case.get('skipped', False)} for case in fixture['inventory']]))
""", encoding="utf-8")
            node.chmod(0o755)
            npm = root / "npm"
            npm.write_text(
                """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
fixture = json.loads(Path('fixture.json').read_text())
marker = Path('attempt')
index = int(marker.read_text()) if marker.exists() else 0
marker.write_text(str(index + 1))
cases = fixture['attempts'][index]
report = {'testResults': [{'name': '/suite.test.ts', 'assertionResults': cases}],
          'numTotalTests': len(cases), 'numPassedTests': sum(c['status'] == 'passed' for c in cases),
          'numFailedTests': sum(c['status'] == 'failed' for c in cases)}
Path(os.environ['EJM_TEST_REPORT']).write_text(json.dumps(report))
print('attempt', index + 1)
raise SystemExit(fixture['codes'][index])
""",
                encoding="utf-8",
            )
            npm.chmod(0o755)
            (root / "fixture.json").write_text(json.dumps({"inventory": inventory, "attempts": [first, second], "codes": codes}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("frontend_flake_check.py")), str(root / "evidence")],
                cwd=root,
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ.get("PATH", "")},
                capture_output=True,
                text=True,
            )
            summary = json.loads((root / "evidence/summary.json").read_text())
            self.assertIn("attempt 1", (root / "evidence/attempt-1.log").read_text())
            self.assertIn("attempt 2", (root / "evidence/attempt-2.log").read_text())
            return result, summary

    def test_first_failure_is_retained_and_complete_identity_is_reported(self) -> None:
        first = [{"ancestorTitles": ["outer", "inner"], "title": "case", "status": "failed"}]
        second = [{**first[0], "status": "passed"}]
        result, summary = self.check(first, second, [{"file": "/suite.test.ts", "name": "outer > inner > case"}], [1, 0])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(summary["exit_codes"], [1, 0])
        self.assertFalse(summary["incomplete"])
        self.assertEqual(summary["mixed"], [["/suite.test.ts", ["outer", "inner", "case"]]])

    def test_missing_and_skipped_tests_fail_without_hiding_other_flakes(self) -> None:
        inventory = [{"file": "/suite.test.ts", "name": name} for name in ("flake", "missing")]
        flake = {"ancestorTitles": [], "title": "flake", "status": "failed"}
        for second_case in ([], [{"ancestorTitles": [], "title": "missing", "status": "skipped"}]):
            result, summary = self.check([flake], [{**flake, "status": "passed"}, *second_case], inventory, [1, 0])
            self.assertEqual(result.returncode, 1)
            self.assertTrue(summary["incomplete"])
            self.assertEqual(summary["mixed"], [["/suite.test.ts", ["flake"]]])

    def test_inventory_skip_fails_without_hiding_other_flakes(self) -> None:
        first = [{"ancestorTitles": [], "title": "flake", "status": "failed"}]
        second = [{**first[0], "status": "passed"}]
        inventory = [{"file": "/suite.test.ts", "name": "flake"},
                     {"file": "/suite.test.ts", "name": "ignored", "skipped": True}]
        result, summary = self.check(first, second, inventory, [1, 0])
        self.assertEqual(result.returncode, 1)
        self.assertTrue(summary["incomplete"])
        self.assertEqual(summary["mixed"], [["/suite.test.ts", ["flake"]]])

    def test_complete_success_and_ambiguous_inventory(self) -> None:
        case = {"ancestorTitles": ["a"], "title": "b", "status": "passed"}
        inventory = [{"file": "/suite.test.ts", "name": "a > b"}]
        result, summary = self.check([case], [case], inventory, [0, 0])
        self.assertEqual(result.returncode, 0)
        self.assertFalse(summary["incomplete"])
        result, summary = self.check([case], [case], inventory * 2, [0, 0])
        self.assertEqual(result.returncode, 1)
        self.assertTrue(summary["incomplete"])

    def test_ambiguous_identities_do_not_hide_unrelated_flakes(self) -> None:
        flake = {"ancestorTitles": [], "title": "flake", "status": "failed"}
        passed = {"ancestorTitles": ["a"], "title": "b", "status": "passed"}
        failed = {**passed, "status": "failed"}
        collision = {"ancestorTitles": [], "title": "a > b", "status": "passed"}
        inventory = [{"file": "/suite.test.ts", "name": name} for name in ("flake", "a > b")]
        for first, second, listed, codes in (
            ([flake, failed], [{**flake, "status": "passed"}, passed], inventory + inventory[1:], [1, 0]),
            ([flake, failed, passed], [{**flake, "status": "passed"}, passed], inventory, [1, 0]),
            ([flake, failed], [{**flake, "status": "passed"}, passed, passed], inventory, [1, 0]),
            ([flake, failed, collision], [{**flake, "status": "passed"}, passed], inventory, [1, 0]),
            ([flake, failed], [{**flake, "status": "passed"}, passed, collision], inventory, [1, 0]),
            ([flake, failed], [{**flake, "status": "passed"}, collision], inventory, [1, 0]),
        ):
            with self.subTest(first=first, second=second, inventory=listed):
                result, summary = self.check(first, second, listed, codes)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(summary["exit_codes"], codes)
                self.assertTrue(summary["incomplete"])
                self.assertEqual(summary["mixed"], [["/suite.test.ts", ["flake"]]])


if __name__ == "__main__":
    unittest.main()
