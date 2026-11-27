# Trust sign-off — the step that stops a client release

## Purpose

Every client we ship (Android, iOS, desktop) carries a TLS trust decision: which certificate
pins it accepts, what cleartext or loopback exemptions it allows, and which connections get a
pinner at all. A wrong value **disconnects every installed client**, and only an app-store
release undoes it — you cannot hot-fix a phone that refuses to talk to the server.

So a client artifact is refused unless that trust decision is **unchanged since the last release**,
or a human has **signed off on the exact new decision**. This runbook is that step. You will meet
it the first time the trust configuration has moved since the last release, and it will stop the
release until you do this.

There is no override. See [If the gate seems wrong](#if-the-gate-seems-wrong).

## When to do this

**Before you cut the release**, not after. The sign-off has to be merged to `main` before the
release PR merges and the tag is cut (see [Order matters](#order-matters-the-sign-off-lands-before-the-tag)).

Run it on every release: if nothing changed it takes one command and prints `OK`.

## Where the refusal comes from

The same check (`packages/protocol/tools/trust-snapshot-cli.ts release-check`) runs in three places.
Each refuses a release whose trust snapshot moved without a sign-off:

| Where | What you see |
|---|---|
| CI on the release PR (branch `release`) and on a `v*` tag push — `packages/protocol/tools/trust-release.test.ts`, in the `repo` suite | the test is red, the release PR cannot merge |
| `scripts/release/sign-artifacts.sh` (local, signing) | `FATAL: refusing to sign — the TLS trust snapshot changed since the last release and no sign-off names it.` and exit code 3 |
| `scripts/release/promote-release.sh` (local, promotion) | `FATAL: refusing to promote — the TLS trust snapshot changed since the last release and no sign-off names it.` and exit code 3 |

CI only gates; publishing is local. The local scripts are the last line, and they check the release
**tag**, not your working tree, so what is checked is what was built.

## 1. Check, before you cut the release

You need full history and tags — the check finds "the last release" from git tags.

```bash
git fetch origin --tags
git rev-parse --is-shallow-repository     # must print: false   (if true: git fetch --unshallow --tags)
git checkout main && git pull
bun install --frozen-lockfile
bun run trust:check
bun run trust:release-check --against v<last-release>
```

- `<last-release>` is the newest whole release tag, e.g. `v0.21.25`. Whole releases only — **not**
  the per-platform `v0.21.25-android` / `-desktop` / `-ios` tags.
- Name it with `--against`. Between releases `package.json` still carries the *last* release's
  version, and the default baseline is the newest tag strictly *lower* than that version, so a bare
  `bun run trust:release-check` compares against the release before the last one. (Seen on a real
  tree: `package.json` at `0.21.25`, bare check ran `against v0.21.24`.)
- `trust:check` must say `trust snapshot is current (digest …)`. If it says
  `packages/protocol/trust.snapshot.json is stale`, the committed snapshot file is behind the tree:
  review the printed lines, then `bun run trust:snapshot` and commit that file in its own PR first.

If the release check exits 0 and prints `OK — the trust snapshot (<12 hex>) is unchanged since the last release`,
**stop here: no sign-off is needed.** Cut the release.

## 2. If it refuses

It prints this (digest and tag will differ; the `+` / `-` / `~` lines are the diff you have to read —
those shown are the real ones from the Android trust refactor, #3075):

```
$ bun packages/protocol/tools/trust-snapshot-cli.ts release-check --against "v0.21.25"
trust release check against v0.21.25: REFUSED — the trust snapshot changed since the last release and no sign-off names its digest 3c34177153f15a7307f1c30cc3f57f0c41b356e2920b4185bfc899106cb0c32d. A wrong trust value disconnects every installed client and only an app-store release undoes it, so rhonda-rodododo must record a sign-off (bun run trust:signoff) in docs/security/trust-signoffs.json after checking the changes above
  + connections.android.apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt.derived[]: "newBuilder pinner=[CertificatePins.pinnerFor(hostname)]"
  + logic.apps/android/app/src/main/java/org/llamenos/hotline/api/CertificatePins.kt::buildPinner#0: "a1788385388bd164"
  - logic.apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt::buildPinner#0: "a1788385388bd164"
  ~ logic.apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt::configurePinning#0: "7ec41c036dbf200b" → "ea403f00846a573b"
  (… more lines)
error: script "trust:release-check" exited with code 1
```

Copy the 64-character digest. That is the thing you will sign.

If the first line instead says `(no previous release to compare against: every value is new)`, the
tool found no earlier release tag — fetch tags (step 1) before you sign anything.

## 3. Decide: read the diff, do not skim it

`+` is a value that is new, `-` one that is gone, `~` one that changed. Each line starts with the
part of the trust decision it belongs to:

| Line starts with | What it is | A change here means |
|---|---|---|
| `pins.` | the certificate pin hashes each client accepts | **A value change.** Every pin must still match a certificate in the chain the production server actually serves, or clients cannot connect. |
| `android.networkSecurityConfigs`, `android.manifests`, `android.buildWiring` | Android's trust anchors, `<pin-set>`, cleartext policy | **A value change.** |
| `ios.` | App Transport Security from `Info.plist` and `project.yml` | **A value change.** |
| `loopbackExemptions.` | the predicates that skip pinning for `localhost` / `127.0.0.1` | A *different condition* is a value change (a widened exemption turns pinning off for more hosts). The *same condition moved to another file* is not. |
| `connections.` | each place a client opens a connection, and **the pinner it is handed** | A connection handed no pinner, or `DEFAULT`, is a client built without pinning: **a value change.** A different expression that resolves to the same pinner is not. |
| `logic.` | a 16-hex digest of one enforcing function's body | Says *that* the body changed, never *how*. Read the source: `git diff v<last-release> HEAD -- <path-before-the-::>`. |

Pin hashes and policy are what you must actually understand. `logic.` digests you must go and read.

### What you are attesting to

By signing, you are saying — in your own words, not the tool's:

> I looked at every trust value that changed. Each one is a change I meant to make. I did not
> sign because the tool nagged me or because the release is late.

If you cannot say that about a line, do not sign. Find out who changed it and why. Nothing here is
urgent enough to ship a trust value you do not understand: the failure is every installed client
going dark with only an app-store release to fix it.

### Pure refactor: values identical, shape moved

This will be the first case you meet (the diff above). The trust *decision* is unchanged; the code
that expresses it moved. Signing it off is **correct**.

Tell it apart from a value change:

```bash
bun run trust:diff v<last-release>
```

It is a refactor only if **all** of these hold:

1. No `pins.` lines at all, and no `android.networkSecurityConfigs`, `android.manifests`,
   `android.buildWiring` or `ios.` lines. (In the diff above there are none.)
2. Every `-` line in `connections.` / `loopbackExemptions.` has a `+` partner that makes the same
   decision. In the example: the loopback predicate `hostname == "localhost" || hostname == "127.0.0.1"`
   is character-for-character the same, now in `CertificatePins.kt` instead of `ApiService.kt`; the
   pinner handed to the connection went from a local `pinner` to `CertificatePins.pinnerFor(hostname)`,
   and `pinnerFor` still returns `CertificatePinner.DEFAULT` only for that loopback predicate.
3. A function that moved shows the **same digest** on its `-` and `+` line (`buildPinner` is
   `a1788385388bd164` on both sides: the body is byte-identical, only the file changed). A `~` line is
   a function whose body *changed*: open the source diff and read it (`configurePinning` did: it now
   calls the new helper, and it no longer takes a `hashes` override parameter — which the digest cannot
   tell you and only reading the source does).
4. You have read the source diff for each `~` and each new `+ logic.` line and can say what it does.

Anything else — a single `pins.` line, an exemption with a different condition, a connection with no
pinner, a `~` you did not read — is a value change. Treat it as one.

## 4. Record the sign-off

Only the named approver (printed in the refusal: `rhonda-rodododo`) can do this, and it is a human
act: nobody and nothing signs on their behalf — not CI, not an agent.

On `main`, at the commit you intend to release (the digest is of *this tree's* trust inputs):

```bash
git checkout main && git pull
bun run trust:check                                      # prints the digest; must be "current"
export TRUST_SIGNOFF_AS=rhonda-rodododo
bun run trust:signoff <the-64-char-digest>
```

Expected:

```
recorded sign-off for <digest> by rhonda-rodododo in docs/security/trust-signoffs.json
```

The tool refuses, with these exact messages, if you get it wrong:

| You did | It prints |
|---|---|
| left `TRUST_SIGNOFF_AS` unset or wrong | `refusing: set TRUST_SIGNOFF_AS to an approver (rhonda-rodododo); signing is a human act` |
| gave a digest that is not this tree's | `refusing: the digest must name THIS tree's snapshot (<digest>); review it with trust:diff first` |

Then commit `docs/security/trust-signoffs.json` on a branch and open a PR. That file is the trust
control: the PR is held until the approver reviews the exact head commit. **That review is what makes
the sign-off mean anything** — the command only appends a line to a file and does not authenticate
anyone. Merge it.

## Order matters: the sign-off lands before the tag

The check reads the sign-off ledger **from the release candidate's own tree** — the release tag.
A sign-off merged after the tag exists is not in the tag's tree, and does not count for that tag.
(Tried: tag cut, then sign-off committed on top: still `REFUSED`.)

So:

1. Run steps 1–4 and **merge the sign-off PR to `main`**.
2. Only then merge the release PR / cut the tag.
3. A tag is never moved to pick up a late sign-off. If the tag already exists without one, that
   release does not ship; merge the sign-off and cut the next release.

A sign-off names **one digest**. If any trust input changes again after you signed — another PR
touching a pin, a manifest, the ATS keys, or an enforcing function — the digest is different and the
sign-off no longer matches. Re-run from step 1. (Tried: a one-line loopback change after sign-off →
`REFUSED` again, and the new line was in the diff.)

## 5. Confirm it clears

After the release PR merges and the tag exists, check the thing that will actually be built:

```bash
bun run trust:release-check --candidate v<new-version>
```

Expected first line:

```
trust release check against v<last-release>: OK — the changed trust snapshot <digest> is signed off by rhonda-rodododo (<timestamp>)
```

Exit code 0. Only now sign and promote (`scripts/release/sign-artifacts.sh`, then
`scripts/release/promote-release.sh`); both repeat this check against the same tag.

## If the gate seems wrong

Do not route around it. There is no `--force`, no environment variable that skips it, no "ship now,
sign later", and you must not hand-edit `docs/security/trust-signoffs.json` to add an entry the tool
did not write: the point of the ledger is that the approver checked the values.

If the diff is noise, or the extractor cannot read a file it should (it fails closed with
`could not read the trust configuration: …`), the fix is in
`packages/protocol/tools/trust-snapshot.ts`, in its own PR with its own review. A release waits for it.

| Symptom | Cause | Fix |
|---|---|---|
| `this is a shallow clone with no release tags, so the previous release cannot be found — fetch with full history and tags (git fetch --unshallow --tags) and re-run` | CI-style shallow checkout | `git fetch --unshallow --tags` |
| refusal lists changes you did not make | bare check compared against the release *before* the last | name the baseline: `--against v<last-release>` |
| `refusing to sign` / `refusing to promote`, exit 3 | the tag's tree has no sign-off for its digest | merge the sign-off, cut the next release (see order above) |
| sign-off merged but still refused | trust inputs changed after you signed, or the sign-off landed after the tag | re-run from step 1 |

## Related

- Android: [android-release.md](android-release.md) · Desktop: [desktop-update-release.md](desktop-update-release.md) ·
  iOS: [../deployment/ios-distribution.md](../deployment/ios-distribution.md)
- Rollback of a bad client release: [rollback.md](rollback.md)
