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

    def test_ellipsis_prefix_is_a_tail_of_a_longer_path(self):
        # "…" (U+2026) is how prose elides the head of a path, exactly as "..." does.
        for s in (f"`\u2026{H}x/`", f"\u2026{H}alice/x", f"...{H}alice/x", f"\u2026{U}alice/x"):
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


class SurfacesAgree(unittest.TestCase):
    """The diff scan and the body scan must give the same verdict on the same text."""

    CASES = {
        "root_in_text": f"cd {H}alice/x",
        "tail_of_longer_path": f"apps{H}alice/x",
        "ellipsis_tail": f"`\u2026{H}x/`",
        "allowlisted_root": f"{H}runner/work",
        "placeholder": f"{H}<user>/x",
        "macos_root": f"cd {U}alice/x",
    }

    def verdicts(self, text):
        via_diff = [r for f in clp.scan_diff(diff_for("docs/x.md", text)) for r in [f.root]]
        via_body = [f.root for f in clp.scan_body(json.dumps(text))]
        return via_diff, via_body

    def test_identical_input_gives_identical_verdict(self):
        for name, text in self.CASES.items():
            via_diff, via_body = self.verdicts(text)
            self.assertEqual(via_diff, via_body, name)

    def test_a_root_fails_on_both_surfaces(self):
        for name in ("root_in_text", "macos_root"):
            via_diff, via_body = self.verdicts(self.CASES[name])
            self.assertEqual(len(via_diff), 1, name)
            self.assertEqual(len(via_body), 1, name)

    def test_tail_and_allowlisted_pass_on_both_surfaces(self):
        for name in ("tail_of_longer_path", "ellipsis_tail", "allowlisted_root", "placeholder"):
            self.assertEqual(self.verdicts(self.CASES[name]), ([], []), name)


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


class LiveBody(unittest.TestCase):
    """#3127: the body is read from the API when the check runs, so an edit clears it.

    `gh` is a stand-in script that answers `api repos/R/pulls/N` from $FAKE_BODY (a
    JSON file holding the reply) and exits $FAKE_RC; nothing here reaches GitHub.
    """

    def setUp(self):
        self.bin = tempfile.mkdtemp()
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", self.bin]))
        gh = os.path.join(self.bin, "gh")
        with open(gh, "w") as fh:
            fh.write('#!/bin/sh\n[ "$1 $2" = "api repos/o/r/pulls/7" ] || exit 9\n'
                     '[ "${FAKE_RC:-0}" = 0 ] || { echo boom >&2; exit "$FAKE_RC"; }\n'
                     'cat "$FAKE_BODY"\n')
        os.chmod(gh, 0o755)

    def run_live(self, reply, rc="0", *extra):
        reply_path = os.path.join(self.bin, "reply.json")
        with open(reply_path, "w") as fh:
            fh.write(reply)
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_BODY": reply_path, "FAKE_RC": rc}
        return subprocess.run([sys.executable, os.path.join(HERE, "check-local-paths.py"),
                               "--body-from-api", "o/r", "7", *extra], capture_output=True, text=True, env=env)

    def test_offending_live_body_fails_without_echoing_the_account(self):
        r = self.run_live(json.dumps({"body": f"ran in {H}alice/wt"}))
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("PR body:1", r.stdout)
        self.assertNotIn("alice", r.stdout + r.stderr)

    def test_the_edited_body_clears_the_check(self):
        """Same PR, same command, no push: only the description changed between the two runs."""
        self.assertEqual(self.run_live(json.dumps({"body": f"ran in {H}alice/wt"})).returncode, 1)
        self.assertEqual(self.run_live(json.dumps({"body": "ran in <shared asdf install>"})).returncode, 0)

    def test_null_body_is_clean(self):
        self.assertEqual(self.run_live(json.dumps({"body": None})).returncode, 0)

    def test_failure_message_names_the_remedy_that_works(self):
        r = self.run_live(json.dumps({"body": f"{H}alice/wt"}))
        self.assertIn("just edit the description", r.stderr)
        self.assertNotIn("push any commit", r.stderr)

    def test_an_unreadable_body_fails_closed(self):
        self.assertEqual(self.run_live("{}", rc="1").returncode, 2)  # gh failed
        self.assertEqual(self.run_live("{}").returncode, 2)  # reply has no `body`
        self.assertEqual(self.run_live("not json").returncode, 2)

    def test_malformed_target_fails_closed(self):
        r = subprocess.run([sys.executable, os.path.join(HERE, "check-local-paths.py"), "--body-from-api", "not a slug", "7"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        r = subprocess.run([sys.executable, os.path.join(HERE, "check-local-paths.py"), "--body-from-api", "o/r", "7;rm"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_the_two_body_sources_are_alternatives(self):
        self.assertEqual(self.run_live(json.dumps({"body": "ok"}), "0", "--body-json", "null").returncode, 2)


if __name__ == "__main__":
    unittest.main()
