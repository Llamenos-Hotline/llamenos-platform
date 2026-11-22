"""Tests for check-local-paths.py (#2918).

Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'

The fixtures are BUILT at run time (H + "alice" ...) rather than written out: a
literal home path in this file would be an added line the guard itself rejects.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("clp", os.path.join(HERE, "check-local-paths.py"))
clp = importlib.util.module_from_spec(spec)
sys.modules["clp"] = clp
spec.loader.exec_module(clp)

H = "/" + "home" + "/"
U = "/" + "Users" + "/"


def diff_for(path: str, *added: str) -> str:
    body = "".join(f"+{a}\n" for a in added)
    return f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,0 +5,{len(added)} @@\n{body}"


class ScanText(unittest.TestCase):
    def roots(self, text):
        return [r for _, r in clp.scan_text(text)]

    def test_linux_and_macos_account_paths_are_findings(self):
        self.assertEqual(self.roots(f"cd {H}alice/projects/x"), ["/home"])
        self.assertEqual(self.roots(f"cd {U}alice/Library"), ["/Users"])

    def test_bare_account_directory_is_a_finding(self):
        self.assertEqual(self.roots(f"HOME={H}alice"), ["/home"])
        self.assertEqual(self.roots(f'"{H}alice"'), ["/home"])

    def test_documented_placeholders_and_runner_are_allowed(self):
        for acct in ("llamenos", "operator", "runner", "ci", "deploy"):
            self.assertEqual(self.roots(f"{H}{acct}/x"), [], acct)
        self.assertEqual(self.roots(f"{U}runner/work"), [])

    def test_templated_and_hidden_segments_are_not_accounts(self):
        for s in (f"{H}<user>/x", f"{H}$USER/x", f"{H}{{user}}/x", f"{H}.local/share", f"{H}~/x"):
            self.assertEqual(self.roots(s), [], s)

    def test_relative_and_tail_of_longer_paths_are_not_findings(self):
        for s in (f"apps{H}alice/x", f"https://example.com{H}alice/x", f"./{H[1:]}alice/x", f"/usr{H}alice/x",
                  "apps/worker/routes/", f"$HOME{H}alice"):
            self.assertEqual(self.roots(s), [], s)

    def test_prefix_longer_account_name_is_not_allowlisted(self):
        self.assertEqual(self.roots(f"{H}runner-alice/x"), ["/home"])
        self.assertEqual(self.roots(f"{H}operators/x"), ["/home"])

    def test_every_occurrence_on_a_line_is_reported(self):
        self.assertEqual(len(self.roots(f"{H}a/x {U}b/y {H}runner/z")), 2)

    def test_line_numbers(self):
        self.assertEqual([n for n, _ in clp.scan_text(f"ok\nok\n{H}alice/x\n")], [3])


class ScanDiff(unittest.TestCase):
    def test_added_line_reports_file_and_line_and_not_the_account(self):
        fs = clp.scan_diff(diff_for("docs/a.md", "ok", f"see {H}alice/x"))
        self.assertEqual([(f.where, f.root) for f in fs], [("docs/a.md:6", "/home")])
        self.assertNotIn("alice", repr(fs))

    def test_removed_and_context_lines_are_ignored(self):
        d = f"--- a/f\n+++ b/f\n@@ -3 +3 @@\n-{H}alice/old\n+clean\n"
        self.assertEqual(clp.scan_diff(d), [])

    def test_deleted_file_is_ignored(self):
        d = f"diff --git a/f b/f\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-{H}alice/x\n"
        self.assertEqual(clp.scan_diff(d), [])

    def test_placeholder_deployment_example_passes(self):
        self.assertEqual(clp.scan_diff(diff_for("deploy/x.yml", f"path: {H}llamenos/app")), [])

    def test_file_header_lines_are_not_content(self):
        # `+++ b/<path>` starts with `+`; a path that itself looks like an account path must not double-report
        d = f"--- a/x\n+++ b/{H[1:]}alice/f\n@@ -0,0 +1 @@\n+clean\n"
        self.assertEqual(clp.scan_diff(d), [])


class ScanBody(unittest.TestCase):
    def test_body_finding_reports_line(self):
        fs = clp.scan_body(json.dumps(f"## Summary\nran in {H}alice/wt\n"))
        self.assertEqual([(f.where, f.root) for f in fs], [("PR body:2", "/home")])

    def test_null_body_is_clean(self):
        self.assertEqual(clp.scan_body("null"), [])

    def test_runner_path_in_a_log_excerpt_is_clean(self):
        self.assertEqual(clp.scan_body(json.dumps(f"at {H}runner/work/x/x.ts:1")), [])

    def test_unparseable_or_non_string_body_fails_closed(self):
        for bad in ("", "{not json", "42", "[]"):
            with self.assertRaises(clp.CouldNotCheck, msg=bad):
                clp.scan_body(bad)


class EndToEnd(unittest.TestCase):
    def run_cli(self, *argv, cwd=None):
        return subprocess.run([sys.executable, os.path.join(HERE, "check-local-paths.py"), *argv],
                              cwd=cwd, capture_output=True, text=True)

    def git(self, cwd, *a):
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True, env=env).stdout.strip()

    def repo(self, content):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", d]))
        self.git(d, "init", "-q", "-b", "main")
        self.git(d, "commit", "-q", "--allow-empty", "-m", "base")
        base = self.git(d, "rev-parse", "HEAD")
        with open(os.path.join(d, "f.txt"), "w") as fh:
            fh.write(content)
        self.git(d, "add", "f.txt")
        self.git(d, "commit", "-q", "-m", "change")
        return d, base, self.git(d, "rev-parse", "HEAD")

    def test_finding_exits_1_without_echoing_the_account(self):
        d, base, head = self.repo(f"x\n{H}alice/secret-project\n")
        r = self.run_cli("--base", base, "--head", head, cwd=d)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("f.txt:2", r.stdout)
        self.assertNotIn("alice", r.stdout + r.stderr)
        self.assertNotIn("secret-project", r.stdout + r.stderr)

    def test_clean_diff_exits_0(self):
        d, base, head = self.repo(f"x\n{H}operator/app\n")
        self.assertEqual(self.run_cli("--base", base, "--head", head, "--body-json", "null", cwd=d).returncode, 0)

    def test_body_finding_exits_1(self):
        d, base, head = self.repo("x\n")
        r = self.run_cli("--base", base, "--head", head, "--body-json", json.dumps(f"{U}bob/x"), cwd=d)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("bob", r.stdout + r.stderr)

    def test_unreadable_range_fails_closed(self):
        d, base, head = self.repo("x\n")
        self.assertEqual(self.run_cli("--base", "0" * 40, "--head", head, cwd=d).returncode, 2)

    def test_bad_body_fails_closed(self):
        d, base, head = self.repo("x\n")
        self.assertEqual(self.run_cli("--base", base, "--head", head, "--body-json", "", cwd=d).returncode, 2)

    def test_nothing_to_check_fails_closed(self):
        self.assertEqual(self.run_cli().returncode, 2)

    def test_half_a_range_fails_closed(self):
        self.assertEqual(self.run_cli("--base", "abc").returncode, 2)


if __name__ == "__main__":
    unittest.main()
