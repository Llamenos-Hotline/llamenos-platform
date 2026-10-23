# CodeQL configuration

`codeql-config.yml` is passed to all three `github/codeql-action/init` steps in
`.github/workflows/codeql.yml` (`config-file:`). It selects the
`security-extended` suite and `paths-ignore`s vendored, generated and test-only
files. Until #2077 nothing referenced it, so none of it had ever applied.

## Principle

Hard-coded cryptographic values are fine in **test** code and not in
**production** code. The tool is configured to know that; the tests are not
restructured to satisfy the tool. Inline literals beside the test that uses
them stay inline, known-answer tests keep their known values, and Rust unit
tests stay in `#[cfg(test)]` beside the code they test.

## What each mechanism can do (verified, not assumed)

| Mechanism | Test code in separate files (JS/TS, Python, Rust `tests/`) | Rust `#[cfg(test)]` in a production file |
|---|---|---|
| `paths-ignore` | Works. Checked with the CLI (2.27.3, `--codescanning-config`): the 3 files in `packages/crypto/tests` drop out of the Rust database, and every JS/TS alert on test files disappears. | Cannot help. Ignoring `apps/desktop/src/crypto.rs` ignores the production crypto in the same file. |
| `query-filters` (`exclude: id: rust/hard-coded-cryptographic-value`) | Not needed. | Filters match query metadata only, never a path, so this is repo-wide and would silence the rule on production crypto. **Do not do this.** |
| Inline `// codeql[rule-id]` suppression | n/a | Not available. CodeQL ships `AlertSuppression.ql` for C/C++, C#, Go, Java/Kotlin, JavaScript and Python only — there is none for Rust (or Ruby, Swift, Actions). |
| The query itself | n/a | `rust/hard-coded-cryptographic-value` has no test-code barrier of its own. |

So for Rust unit tests inside production source files the only supported
control is **alert dismissal**. It is per-alert, so it recurs when a new test
adds a literal. That is accepted; the alternative (moving tests out of the
file, or randomising known-answer values) is rejected.

## Dismissal policy for `rust/hard-coded-cryptographic-value`

An alert may be dismissed only after reading the flagged line:

- Inside `#[cfg(test)]` / a `#[test]` fn, value is a test vector or fixture:
  dismiss as **used in tests**.
- Production code where the flagged value is a zero-initialised output buffer
  (`let mut okm = [0u8; 32];`) that HKDF / Argon2 / `fill_bytes` then fills —
  CodeQL cannot see the fill: dismiss as **false positive**, with a comment
  naming the call that fills it. If the fill is a plain `fill_bytes`, prefer
  the code fix used in #2074 where it does not hurt readability.
- Production code where a real key, salt, IV, nonce or password is a literal:
  **fix it.** Never dismiss.

```sh
gh api -X PATCH repos/Llamenos-Hotline/llamenos-platform/code-scanning/alerts/<n> \
  -f state=dismissed -f dismissed_reason='used in tests' \
  -f dismissed_comment='#[cfg(test)] known-answer vector; see .github/codeql/README.md'
```

## Verifying a change to this config

Check the **`github-advanced-security`** `CodeQL` check-run (the alert gate),
not just the `github-actions` rollup: they disagree, and the rollup can be
green while the gate is not. `CodeQL` is a required context on `main`, so what
is and is not scanned is part of the merge gate.

To see what the config does without waiting for CI, download the CodeQL bundle
from `github/codeql-action` releases, then:

```sh
codeql database create /tmp/db --language=rust --source-root=. --build-mode=none \
  --codescanning-config=.github/codeql/codeql-config.yml
codeql database analyze /tmp/db codeql/rust-queries:codeql-suites/rust-security-extended.qls \
  --format=sarif-latest --output=/tmp/out.sarif
```

`paths-ignore` is honoured for `javascript-typescript`, `python`, `ruby` and
`rust` (no build). It is **not** applied to the staged `java-kotlin` and
`swift` legs, which are built.
