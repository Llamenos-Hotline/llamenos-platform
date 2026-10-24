# packages/shared

Cross-boundary TypeScript types, constants, and utilities shared between the frontend (`src/client/`) and the backend (`apps/worker/`).

## Contents

| File | Purpose |
|------|---------|
| `types.ts` | Shared types re-exported from `@protocol/schemas` (RecipientEnvelope, KeyEnvelope, etc.) |
| `crypto-labels.ts` | Domain separation constants re-exported from `packages/protocol` |
| `languages.ts` | Language configuration (codes, display labels, Twilio voice IDs) |
| `permissions.ts` | Role-based permission definitions |
| `ws-events.ts` | Nostr event type constants |
| `voice-prompts.ts` | IVR voice prompt configuration |

## Usage

Import via the `@shared/*` path alias:

```typescript
import type { RecipientEnvelope } from '@shared/types'
import { LABEL_NOTE_KEY } from '@shared/crypto-labels'
```

## Important

Canonical types for API requests/responses come from `@protocol/schemas` — `packages/shared/types.ts` re-exports from there rather than defining its own. If you need a new shared type, add it to a Zod schema in `packages/protocol/schemas/` and run `bun run codegen`.
