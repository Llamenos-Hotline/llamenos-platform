# Hub Shred Set — Mutation Log (Task 6 evidence)

Plan: `docs/superpowers/plans/2026-10-04-hub-deletion-crypto-shred.md` Task 6.
Each mutation was applied, the named suite run, and the mutation reverted.
Nothing in this log is committed as a code change — the deliverable is the
evidence that removing a member of the shred set turns a test red.

Baseline before every mutation: `hub-shred-execute.test.ts` 7/7 and
`hub-shred-isolation.test.ts` 7/7 green against real PostgreSQL on an isolated
database, run with:

```bash
bunx vitest run --config vitest.integration.config.ts <file>
```

## Mutation A — drop `files` from `HUB_SHRED_TARGETS`

Change: commented out the `files` clear-envelopes entry in
`apps/worker/services/hub-shred-targets.ts`.

Run: `hub-shred-execute.test.ts`.
Result: **CAUGHT.** `clears the file envelope columns AND deletes the blob-store
mirrors` fails — `recipient_envelopes` still holds a usable wrap after the
shred, and `verifyShredded` reports `files.recipient_envelopes` residue, which
rolls the transaction back so the assertion on the cleared column fails first.
Reverted.

## Mutation B — keep the blob-store mirror

Change: made `deleteBlobEnvelopeMirrors` an unconditional no-op in
`apps/worker/services/hub-shred.ts`.

Run: `hub-shred-execute.test.ts`.
Result: **CAUGHT.** The same file case fails — and specifically on the mirror
assertions, not the column: the test reads the wrap back out of the fake blob
store (`blob.objects.has('files/<id>/envelopes')`) and decrypts with it before
the shred, so it cannot pass on a cleared column alone. Reverted.

## Mutation C — drop `hub_recovery_group_shares`

Change: commented out the `hub_recovery_group_shares` delete-rows entry.

Run: `hub-shred-isolation.test.ts`.
Result: **SLIPPED THROUGH at the behavioral layer — caught at the structural
layer.** `destroys the recovery shares that could reconstruct the hub key`
still passes because `hub_recovery_group_shares.hub_id` has
`ON DELETE CASCADE` from `hub_recovery_groups`, which the shred set deletes
immediately after: the cascade destroys the shares even with the target
removed. The behavioral suite therefore cannot distinguish "shred deleted the
shares" from "the FK deleted them" — and the honest invariant is that the
declaration itself must name the table, so the shred stays complete even if the
cascade is ever removed or deferred.

The structural invariant catches it: with the entry removed, the Task 3 unit
test `covers every class in spec §4` in
`apps/worker/__tests__/unit/hub-shred-targets.test.ts` fails with
"`hub_recovery_group_shares` is in the spec's shred set but not in
HUB_SHRED_TARGETS". No additional test was added — the existing structural
test is the correct layer for this member, and the behavioral test is retained
as documentation of the cascade dependency. Reverted.

## Mutation D — omit the key-generation bump

Change: removed `hub_key_generation = hub_key_generation + 1` from the
executor's terminal `UPDATE hubs`.

Run: `hub-shred-execute.test.ts` + `hub-shred-isolation.test.ts`.
Result: **CAUGHT.** `marks the hub shredded and advances the key generation`
fails: generation is unchanged after the shred. (The replay test in the
isolation file still passes under this mutation because the shredded-status
guard refuses the write first — the two guards are redundant by design, and
the generation assertion is the one that pins this mutation.) Reverted.

## Mutation E — the inverse: add `puk_envelopes`

Change: added `{ kind: 'delete-rows', table: 'puk_envelopes', scope: BY_HUB }`
to `HUB_SHRED_TARGETS`.

Run: `apps/worker/__tests__/unit/hub-shred-targets.test.ts`.
Result: **CAUGHT, twice, before any integration test ran.** `names no
cross-hub table` fails ("puk_envelopes is user- or platform-scoped: shredding
it for one hub would revoke the same user's access to every other hub they
belong to") and `names only real tables, real columns and real hub predicates`
fails ("puk_envelopes has no hub_id column"). The over-reach is unrepresentable
— the declaration rejects it structurally, which is the design intent
(isolation must catch over-reach, not just under-reach). Reverted.

## Verdict

Four of five mutations turn a behavioral test red; the fifth is caught by the
structural invariant, with the masking cascade behavior recorded above. No
mutation passed silently, and no test was weakened to make one pass.
