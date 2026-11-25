---
name: protocol-schema-change
description: >
  Guide JSON Schema and protocol changes through the multi-platform codegen pipeline in the
  Llamenos monorepo. Use this skill when modifying files in packages/protocol/schemas/,
  changing crypto-labels.json, updating wire formats, adding new message types, or when
  the user mentions "schema change", "protocol update", "codegen", "wire format", "new message
  type", "crypto label", "domain separation", "add a field", "new field", "envelope format",
  or "shared types". Also use when the user describes adding or modifying data structures that
  need to work across all platforms (desktop, iOS, Android, worker) — this implies a protocol
  change. If a change touches encrypted payload formats or cross-platform type definitions,
  this skill applies. Schema changes have blast radius across every platform — this skill
  ensures nothing is missed.
---

# Protocol Schema Changes for Llamenos

The protocol layer (`packages/protocol/`) defines the source-of-truth types and crypto constants
shared across all platforms. Changes here propagate to TypeScript, Swift, and Kotlin via codegen.
Missing a step means type mismatches, runtime crashes, or crypto failures on one or more platforms.

## Architecture

```
packages/protocol/
  schemas/              # 42+ Zod schema files (SOURCE OF TRUTH)
    common.ts           # Pagination, errors, envelopes, crypto types
    auth.ts             # Login, bootstrap, profile, session types
    notes.ts            # Note CRUD, replies, custom fields
    conversations.ts    # Messages, threads, assignment
    calls.ts            # Call state, routing, recording
    shifts.ts           # Shift scheduling, ring groups
    volunteers.ts       # Volunteer profiles, activation
    reports.ts          # Reports, categories, report types
    entity-schema.ts    # CMS: EntityTypeDefinition, fields, enums, statuses
    records.ts          # CMS: Case records, assignment, linking
    evidence.ts         # CMS: Evidence, chain of custody
    interactions.ts     # CMS: Case interactions, timeline
    events.ts           # CMS: Events, sub-events, location
    contact-relationships.ts  # CMS: Relationships, affinity groups
    report-links.ts     # CMS: Report-record-event M:N links
    report-types.ts     # CMS: ReportTypeDefinition, report fields
    blasts.ts           # Broadcast messaging, subscribers
    hubs.ts             # Multi-hub, hub settings
    settings.ts         # App settings, feature flags
    invites.ts          # Invite codes, redemption
    bans.ts             # Ban list, phone hash bans
    audit.ts            # Audit log, hash chain
    devices.ts          # Device linking, provisioning
    files.ts            # File uploads, chunks, metadata
    webauthn.ts         # WebAuthn ceremonies
    webrtc.ts           # WebRTC signaling
    system.ts           # Health, system status
    index.ts            # Barrel export of all schemas
  tools/
    codegen.ts          # Zod → toJSONSchema() → quicktype-core → Swift/Kotlin
    schema-registry.ts  # Maps 85+ Zod schemas to named PascalCase types for codegen
  generated/            # GITIGNORED — regenerated on every `bun run codegen`
    swift/Types.swift          # ~122 KB Swift Codable structs (with Sendable)
    swift/CryptoLabels.swift
    kotlin/Types.kt            # ~103 KB Kotlin @Serializable data classes
    kotlin/CryptoLabels.kt
  crypto-labels.json    # 68 domain separation constants (source of truth)
```

## Zod Schema Conventions

Schemas are written in Zod 4. Key patterns:

### Field Defaults (CRITICAL)

**Always use `.optional().default(value)`, NEVER bare `.default(value)`:**

```typescript
// ✅ CORRECT — generates proper optional+default in all languages
allowFileAttachments: z.boolean().optional().default(true)

// ❌ WRONG — Zod 4's toJSONSchema() treats as required, breaks Kotlin/Swift
allowFileAttachments: z.boolean().default(true)
```

Why: `.optional().default()` makes the field not-required in JSON Schema but includes a `"default"` value. The Kotlin post-processor reads this default and injects it into the generated data class. Bare `.default()` makes the field required with no default, causing deserialization failures when the field is absent.

### Common Patterns

```typescript
// String with constraints
name: z.string().min(1).max(200)

// Optional nullable field
phone: z.string().nullable().optional()

// Enum
status: z.enum(['active', 'archived', 'deleted'])

// UUID (Zod 4 style — NOT z.string().uuid())
id: z.uuid()

// Array with default
tags: z.array(z.string()).optional().default([])

// Nested object reference (import from another schema file)
envelope: RecipientEnvelopeSchema
```

### Adding a New Schema

1. Create `packages/protocol/schemas/my-type.ts`
2. Export Zod schemas (e.g., `export const MyTypeSchema = z.object({...})`)
3. Register in `packages/protocol/tools/schema-registry.ts`:
   ```typescript
   import { MyTypeSchema, MyCreateBodySchema } from '../schemas/my-type.js'
   // Add to schemaEntries array:
   ['MyType', MyTypeSchema],
   ['MyCreateBody', MyCreateBodySchema],
   ```
4. Export from `packages/protocol/schemas/index.ts`

## Codegen Pipeline Details

### Kotlin Post-Processor (`postProcessKotlin()`)

Handles a quicktype limitation: quicktype doesn't emit Kotlin default values from JSON Schema `"default"`. The post-processor:

1. Reads the JSON Schema to find fields with `"default"` values
2. Pattern-matches generated Kotlin `val fieldName: Type,` declarations
3. Injects defaults: `val fieldName: Type = defaultValue,`
4. Type-aware: `Boolean` → `false/true`, `Long` → `0L`, `String` → `""`, `List<*>` → `emptyList()`
5. Skips enum-typed strings to avoid type mismatch

**Limitation**: Only handles scalar defaults and empty lists. Nested object defaults or complex list defaults require hand-written wrapper types (see Android `CaseModels.kt` lenient `EntityTypeDefinition`).

### Swift Post-Processor (`stripSwiftConvenienceExtensions()`)

1. Strips quicktype's verbose convenience initializer extensions (keeps struct/enum + CodingKeys only)
2. Adds `Sendable` conformance to all structs/enums
3. Renames types that shadow Swift built-ins or framework types:
   - `Error` → `InviteError`, `Event` → `ProtocolEvent`, `Record` → `CaseLinkRecord`
   - `Location` → `EventLocation`, `Value` → `FieldValue`, `Category` → `ReportTypeCategory`
   - See `codegen.ts` lines 124-251 for full list

## Schema Change Workflow

### Step 1: Modify the Zod Schema

Edit the relevant file in `packages/protocol/schemas/`. All schemas use Zod 4.

### Step 2: Register New Types (if adding schemas)

Add entries to `packages/protocol/tools/schema-registry.ts`. The registry maps Zod schemas to PascalCase type names:

```typescript
['MyNewType', MyNewTypeSchema],
['CreateMyNewTypeBody', CreateMyNewTypeBodySchema],
```

### Step 3: Add/Update Crypto Labels (if needed)

Edit `packages/protocol/crypto-labels.json`:

```json
{
  "LABEL_NEW_CONTEXT": "llamenos:new-context:v1"
}
```

Rules:
- Prefix with `llamenos:`
- Include version suffix (`:v1`) for future migration
- Use kebab-case after the prefix
- NEVER use raw string literals in code — always reference the generated constant
- Each label must be unique

### Step 4: Run Codegen

```bash
bun run codegen
```

### Step 5: Update Platform Consumers

**Desktop/Worker (TypeScript)** — uses `z.infer<typeof Schema>` directly from `@protocol/schemas`:
- Update route handlers, components, hooks, platform.ts crypto operations
- No generated TypeScript types — import Zod schemas and infer types at compile time

**iOS (Swift)** — generated types in `packages/protocol/generated/swift/Types.swift`:
- Copy to `apps/ios/Sources/Generated/` if not auto-synced
- Note: 15 types are renamed (see Swift post-processor above)
- Update ViewModels, CryptoService if labels changed

**Android (Kotlin)** — generated types in `packages/protocol/generated/kotlin/Types.kt`:
- Build imports from `org.llamenos.protocol` package
- For types with complex nested defaults, may need lenient wrapper in `CaseModels.kt`
- Update repositories, ViewModels, CryptoService if labels changed

### Step 6: Update Protocol Documentation

If the change affects the wire format, update `docs/protocol/PROTOCOL.md`.

### Step 7: Test

```bash
bun run test:changed    # Test affected platforms
bun run codegen:check   # Verify codegen is fresh (CI runs this)
```

## Breaking vs Non-Breaking Changes

### Non-Breaking (safe)
- Adding new optional fields (use `.optional()` or `.optional().default()`)
- Adding new schema files (new types)
- Adding new crypto labels

### Breaking (requires migration)
- Removing or renaming fields
- Changing field types
- Changing enum values
- Modifying crypto label values (changes wire format!)

For pre-production: clean breaks acceptable. Document in the epic.

## Common Pitfalls

- **Stale codegen**: Always run `bun run codegen` after schema changes. CI catches via `codegen:check`
- **Bare `.default()`**: MUST use `.optional().default()` — bare `.default()` breaks Kotlin/Swift defaults
- **Raw string literals**: NEVER use `"llamenos:note-seal"` directly — import from generated constants
- **Missing platform updates**: Schema changes affect ALL platforms (desktop, worker, iOS, Android)
- **Swift type collisions**: quicktype may generate names that shadow Swift built-ins. Check the rename list in `codegen.ts`
- **Kotlin nested defaults**: The post-processor only handles scalar/empty-list defaults. Complex nested types need hand-written lenient wrappers
- **Crypto label collision**: Every label must be unique. Check existing labels before adding
- **Import path**: Use `@protocol/schemas` (NOT `@worker/schemas` — old path, schemas moved)
