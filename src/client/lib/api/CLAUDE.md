# CLAUDE.md — src/client/lib/api

The desktop HTTP client. Every module here wraps backend routes that are
already fully described by Zod schemas in `packages/protocol/schemas/`.

## The rule

**Derive types. Never hand-write them.**

`packages/protocol/schemas/` is the single source of truth for every request
body and every response shape in this directory. It exports hundreds of schemas.
If you are typing a request or a response here, the type already exists —
import it, or infer it from the schema. Writing the shape out by hand is the
defect this file exists to prevent, and it is not a style preference: a
hand-written type compiles cleanly while disagreeing with the server, so
nothing fails and the drift ships.

```ts
// WRONG — a second, unverified copy of a shape the server already defines
export async function createUser(data: { name: string; phone: string; roleIds: string[]; pubkey: string }) {
  return request<User>(hp('/users'), { method: 'POST', body: JSON.stringify(data) })
}

// RIGHT — one definition, enforced by the same schema the server validates with
import type { CreateUserBody, User } from '@protocol/schemas'

export async function createUser(data: CreateUserBody) {
  return request<User>(hp('/users'), { method: 'POST', body: JSON.stringify(data) })
}
```

TypeScript consumers import the PascalCase types from `@protocol/schemas`
directly — no codegen step is needed for TS. (`bun run codegen` exists for
Swift and Kotlin, which cannot import Zod.)

If the PascalCase type does not exist yet, add it next to its schema in
`packages/protocol/schemas/`, e.g.
`export type CreateUserBody = z.infer<typeof createUserBodySchema>` — one line
there, reusable by every consumer. Do not reach for `z.infer` at the call site
in this directory, and do not define the shape locally.

## Why this keeps regressing

The pattern is self-replicating. Someone adding an endpoint copies the
function next to it, and the neighbour hand-writes its types, so the next one
does too. Nothing breaks: `bun run typecheck` passes because an inline type is
internally consistent — it simply is not the server's type. There is no
feedback until something fails at runtime, or silently returns a field the UI
never reads.

These drifts were real, and the binding report found and fixed each one (the list is
illustrative, not exhaustive):

- `createUser` accepted **4 fields** where `createUserBodySchema` defines **10**.
- `listUsers` was typed with `User` (which has `phone`) while the route declared a member
  shape without it. Phone numbers are admin-only, and every `/users` route is gated on
  `users:read`, so the routes now declare `userAdminResponseSchema` and the types agree.
- The retention screen PATCHed `{ category, retentionDays }` to a route that validates
  `{ settings: [...] }`; the blast settings screen edited `optOutFooter` and
  `rateLimitPerSecond`, which the validator stripped, so they were never saved.

`bun scripts/api-schema-binding/bind-report.ts --check` is the ratchet: it fails on any
UNBOUND (hand-written) or MISMATCHED (wrong protocol type) shape, or a stale
`scripts/api-schema-binding/report.md`, and it runs in CI as part of the repo-level bun
tests (`bind-report.test.ts`). Fix a finding by importing the protocol type — if the
server's declared schema is what is wrong, fix the schema, not the client.

## Before you add or edit a function here

1. Find the route's schemas in `packages/protocol/schemas/` — request body and
   response both. The naming is consistent: `createXBodySchema`,
   `updateXBodySchema`, `xResponseSchema`, `xListResponseSchema`.
2. If a schema is genuinely missing, add it **there** and use it from both
   sides. Do not work around its absence with a local type.
3. Use the shared `request` / `hp` helpers from `./client`. Those are the only
   hand-written transport concern in this directory; everything else is shape,
   and shape comes from the protocol package.
4. Keep modules domain-scoped, one file per domain, as they are now. `api.ts`
   at the parent level is a re-export barrel only — put no logic in it.

## Related

- `packages/protocol/schemas/` — source of truth (Zod)
- `packages/protocol/tools/schema-registry.ts` — maps schemas to named types
- `packages/protocol/tools/codegen.ts` — Zod → Swift/Kotlin (TS needs no step)
- Root `CLAUDE.md` — "Protocol codegen" and "Zod `.optional().default()`"
