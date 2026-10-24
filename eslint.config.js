import tseslint from 'typescript-eslint'
import noInlineApiShape from './scripts/eslint-rules/no-inline-api-shape.js'

/**
 * no-plaintext-in-encrypted-field (#1506) — a value that is legible at the
 * assignment site may not be written to a field whose name claims it is
 * encrypted.
 *
 * `ring_groups.encrypted_name` and `shifts.encrypted_name` hold raw user
 * input (`encryptedName: nameInput.trim()`), while the same field name on
 * platform roles holds a real HPKE envelope
 * (`encryptedName: JSON.stringify(nameEnvelope)`). A column named
 * `encrypted_*` that may or may not be encrypted is worse than an honest
 * plaintext column: every reader — human, migration, crypto-shred coverage
 * analysis — is actively misled.
 *
 * The rule cannot prove a value IS an envelope, so it flags the assignments
 * that provably are NOT:
 *
 *   - a non-empty string literal     `encryptedName: 'Morning Team'`
 *   - any template literal
 *   - a call that is not a seal/serialise path:
 *       allowed:  JSON.stringify(...)                  (envelope serialisation)
 *                 encrypt* / seal* / wrap* / hpke*(...) (sealing helpers)
 *                 z.*(...)                              (zod schema declarations)
 *                 drizzle column builders (text/jsonb…) (db schema declarations)
 *       flagged:  nameInput.trim(), btoa(...), textToHex(...), String(...)
 *
 * Pass-throughs are allowed: identifiers, member expressions
 * (`encrypted.encryptedContent`, `group.encryptedName`), `??` / `?:` whose
 * branches are all allowed, and empty-string placeholders.
 *
 * Known pre-#1506 violations are downgraded to `warn` in the debt block below —
 * remove each entry as the client lanes adopt `encryptHubField`
 * (src/client/lib/platform.ts) for these fields. Test files are exempt: their
 * fixtures construct fake envelope strings deliberately. Kotlin/Swift writes
 * are out of ESLint's reach entirely — the same class of guard has to come
 * from the mobile lanes' own tooling.
 */

/** Drizzle pg-core column builders — declarations, not value assignments. */
const DRIZZLE_BUILDERS = new Set([
  'text', 'varchar', 'char', 'jsonb', 'json', 'integer', 'bigint', 'smallint',
  'boolean', 'timestamp', 'date', 'time', 'uuid', 'numeric', 'decimal', 'real',
  'doublePrecision', 'serial', 'bigserial', 'smallserial', 'interval', 'bytea',
  'pgEnum', 'primaryKey', 'index', 'uniqueIndex', 'check', 'foreignKey',
])

/** Sealing/serialising call names — a value produced by one is not legible here. */
const SEAL_CALL = /encrypt|seal|wrap|hpke/i

/** Walk member/call chains to the identifier the whole expression hangs off. */
function rootIdentifier(node) {
  let current = node
  while (current) {
    if (current.type === 'Identifier') return current.name
    if (current.type === 'MemberExpression') { current = current.object; continue }
    if (current.type === 'CallExpression') { current = current.callee; continue }
    return null
  }
  return null
}

/** Outermost function name being invoked, if statically visible. */
function calleeName(node) {
  const callee = node.callee
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name
  }
  return null
}

function isJsonStringify(node) {
  const callee = node.callee
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' && callee.object.name === 'JSON' &&
    callee.property.type === 'Identifier' && callee.property.name === 'stringify'
  )
}

function isAllowedCall(node) {
  if (isJsonStringify(node)) return true
  const root = rootIdentifier(node.callee)
  if (root === 'z' || (root && DRIZZLE_BUILDERS.has(root))) return true
  const name = calleeName(node)
  return name !== null && SEAL_CALL.test(name)
}

/** Returns the offending sub-expression if provably legible, else null. */
function legibleExpression(node) {
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' && node.value.length > 0 ? node : null
    case 'TemplateLiteral':
      return node
    case 'CallExpression':
      return isAllowedCall(node) ? null : node
    case 'AwaitExpression':
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
      return legibleExpression(node.argument ?? node.expression)
    case 'LogicalExpression':
      return legibleExpression(node.left) ?? legibleExpression(node.right)
    case 'ConditionalExpression':
      return legibleExpression(node.consequent) ?? legibleExpression(node.alternate)
    default:
      return null
  }
}

function encryptedKeyName(key) {
  if (key.type === 'Identifier') return /^encrypted([A-Z_])/.test(key.name) ? key.name : null
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return /^encrypted([A-Z_])/.test(key.value) ? key.value : null
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const noPlaintextInEncryptedField = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow provably-plaintext values (literals, .trim() of user input, btoa, …) ' +
        'assigned to encrypted* fields — see issue #1506.',
      recommended: true,
    },
    schema: [],
    messages: {
      plaintext:
        "'{{name}}' is assigned a value that is legible right here — it is not an envelope. " +
        'A field named encrypted_* must hold the output of a seal/encrypt path ' +
        '(e.g. encryptHubField / hpkeSeal, serialised with JSON.stringify), never user ' +
        'input. See issue #1506.',
    },
  },
  create(context) {
    return {
      Property(node) {
        const name = encryptedKeyName(node.key)
        if (!name) return
        const offender = legibleExpression(node.value)
        if (offender) {
          context.report({ node: offender, messageId: 'plaintext', data: { name } })
        }
      },
    }
  },
}

// Flat config refuses to redefine a plugin across blocks, so every `local/`
// rule hangs off this one shared object.
const localPlugin = {
  rules: {
    'no-inline-api-shape': noInlineApiShape,
    'no-plaintext-in-encrypted-field': noPlaintextInEncryptedField,
  },
}

export default tseslint.config(
  { ignores: ['dist/', '.features-gen/', 'packages/protocol/generated/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  // Test files use partial mocks that require 'any' casts — relax the rule.
  // Globs cover every place tests live: unit tests colocated with source,
  // BDD step definitions + helpers under tests/, cross-platform specs under
  // packages/test-specs/, and desktop WebdriverIO specs (*.wdio.ts).
  {
    files: [
      '**/__tests__/**/*.ts',
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.wdio.ts',
      'tests/**/*.ts',
      'packages/test-specs/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  // Desktop lane (#703) takes the `any` ban back for its own trees: src/client's
  // colocated tests and everything under tests/ except tests/steps/backend/, which
  // is the backend lane (#702, still open) and stays exempt via the block above.
  // Every other tests/steps/ subtree is desktop Playwright step code. The shared
  // lane's packages/test-specs/ stays exempt too (#704).
  {
    files: [
      'src/client/**/__tests__/**/*.ts',
      'src/client/**/*.test.ts',
      'src/client/**/*.spec.ts',
      'tests/**/*.ts',
    ],
    ignores: ['tests/steps/backend/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Domain-separation rail (#1033): crypto contexts come from the generated registry
  // (@shared/crypto-labels), never a raw 'llamenos:*' literal — a literal drifts silently when
  // packages/protocol/crypto-labels.json changes. version.ts (DOM event name) and
  // transcription (localStorage key) are not crypto contexts.
  {
    files: ['src/client/lib/**/*.ts'],
    ignores: [
      'src/client/lib/**/*.test.ts',
      'src/client/lib/version.ts',
      'src/client/lib/transcription/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/^llamenos:/]",
        message: "Use the generated constant from '@shared/crypto-labels' instead of a raw 'llamenos:' literal.",
      }],
    },
  },
  // api-schema-binding rail (see scripts/api-schema-binding/): a hand-written request/response
  // shape here is a build error, so the client/server drift documented in
  // scripts/api-schema-binding/report.md cannot keep spreading by copy-paste from a neighbour.
  {
    files: ['src/client/lib/api/**/*.ts'],
    plugins: { local: localPlugin },
    rules: {
      'local/no-inline-api-shape': 'error',
    },
  },
  // Pre-existing debt from before this rule existed (see report.md for the full inventory).
  // Downgraded to `warn` — not disabled — so `bun run lint` stays informative on these files
  // without blocking unrelated PRs on a cleanup that isn't theirs to do.
  //
  // This list was originally just `hub-onboard.ts`/`provider-setup.ts` — the only two
  // domain modules that existed when this rail was authored. #874 (splitting api.ts into
  // per-domain modules) landed independently and finished the split before this PR did,
  // carrying every hand-written shape over unchanged into ~40 new files. Rebasing this PR
  // onto that state turned "two known exceptions" into "38 of 40 files in the directory",
  // which is `report.md`'s own UNBOUND/MISMATCHED count, not a new problem — regenerate the
  // report and re-narrow this list file-by-file as each one is migrated to a protocol type;
  // do not add new files here going forward, since new code should bind from the start.
  {
    files: [
      'src/client/lib/api/audit.ts',
      'src/client/lib/api/auth.ts',
      'src/client/lib/api/bans.ts',
      'src/client/lib/api/blasts.ts',
      'src/client/lib/api/call-settings.ts',
      'src/client/lib/api/calls.ts',
      'src/client/lib/api/client.ts',
      'src/client/lib/api/cms-report-types.ts',
      'src/client/lib/api/cms.ts',
      'src/client/lib/api/contacts.ts',
      'src/client/lib/api/conversations.ts',
      'src/client/lib/api/directory.ts',
      'src/client/lib/api/evidence.ts',
      'src/client/lib/api/files.ts',
      'src/client/lib/api/firehose.ts',
      'src/client/lib/api/governance.ts',
      'src/client/lib/api/hub-onboard.ts',
      'src/client/lib/api/hubs.ts',
      'src/client/lib/api/interactions.ts',
      'src/client/lib/api/invites.ts',
      'src/client/lib/api/ivr-audio.ts',
      'src/client/lib/api/messaging-config.ts',
      'src/client/lib/api/migrations.ts',
      'src/client/lib/api/notes.ts',
      'src/client/lib/api/provider-setup.ts',
      'src/client/lib/api/records.ts',
      'src/client/lib/api/recovery.ts',
      'src/client/lib/api/reports.ts',
      'src/client/lib/api/ring-groups.ts',
      'src/client/lib/api/roles.ts',
      'src/client/lib/api/setup.ts',
      'src/client/lib/api/shifts.ts',
      'src/client/lib/api/signal.ts',
      'src/client/lib/api/tags.ts',
      'src/client/lib/api/teams.ts',
      'src/client/lib/api/telephony.ts',
      'src/client/lib/api/triage.ts',
      'src/client/lib/api/users.ts',
    ],
    rules: {
      'local/no-inline-api-shape': 'warn',
    },
  },
  // encrypted-means-encrypted rail (#1506): a value that is legible at the
  // assignment site (string literal, `.trim()` of user input, `btoa(...)`) may
  // not be written to an `encrypted*` field anywhere in the TS surface. Test
  // trees are exempt — their fixtures deliberately construct fake envelope
  // strings, and the rule cannot tell a fake envelope from a real one.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.wdio.ts',
      'tests/**',
      'packages/test-specs/**',
    ],
    plugins: { local: localPlugin },
    rules: {
      'local/no-plaintext-in-encrypted-field': 'error',
    },
  },
  // Pre-existing #1506 debt, downgraded to `warn` — not disabled — so lint
  // stays informative without blocking unrelated PRs on a cleanup that is not
  // theirs. Remove each file as it is fixed:
  //   ring-groups-panel.tsx / shifts.tsx — the defect itself: raw user input
  //     into ring_groups.encrypted_name / shifts.encrypted_name. Fixed when the
  //     desktop lane routes these through encryptHubField (hub-key path, same
  //     as tags/teams).
  //   demo.ts — demo seed data; demo mode removal is in flight (#1651).
  //   dev.ts — dev-surface BDD seeds (`btoa('BDD Test Shift')`); the backend
  //     lane owns this file and re-seeds through envelopes when the wire fix
  //     lands.
  //   firehose.ts — trims an already-encrypted pass-through value, not
  //     plaintext introduction.
  //   hub-shred-targets.ts — column→clear-value directive maps
  //     (`encrypted_metadata: "'[]'::jsonb"`), not payloads.
  {
    files: [
      'src/client/components/shifts/ring-groups-panel.tsx',
      'src/client/routes/shifts.tsx',
      'src/client/lib/api/demo.ts',
      'apps/worker/routes/dev.ts',
      'apps/worker/routes/firehose.ts',
      'apps/worker/services/hub-shred-targets.ts',
    ],
    rules: {
      'local/no-plaintext-in-encrypted-field': 'warn',
    },
  },
)
