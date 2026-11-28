#!/usr/bin/env bun
/**
 * bind-report.ts — the route -> schema binding report.
 *
 * Combines:
 *   - extract-server-routes.ts  (Hono route definitions -> full paths + schemas)
 *   - extract-client-calls.ts   (src/client/lib/api/** exported functions -> path/method/types)
 *   - protocol-schema-index.ts  (which Zod schemas have a PascalCase `z.infer` type alias)
 *
 * ...into one deterministic, re-runnable table: for every exported client API
 * function, is its body/response type BOUND to the protocol schema the server
 * actually validates/returns, UNBOUND (hand-written, drift-prone), or
 * MISMATCHED (imports a protocol type, but not the right one)?
 *
 * Usage:
 *   bun scripts/api-schema-binding/bind-report.ts             # regenerate report.md + report.json
 *   bun scripts/api-schema-binding/bind-report.ts --check      # exit 1 if the committed report is stale
 *   bun scripts/api-schema-binding/bind-report.ts --summary    # print only the summary counts
 *
 * No model involvement anywhere in this file or its imports — every row is
 * derived from parsing committed source with the TypeScript compiler API.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { extractServerRoutes, type ResolvedServerRoute } from './extract-server-routes'
import { extractClientCalls, type ClientCall, type TypeDescriptor } from './extract-client-calls'
import { buildProtocolSchemaIndex, type ProtocolSchemaIndex } from './protocol-schema-index'

const REPORT_JSON = resolve(import.meta.dirname, 'report.json')
const REPORT_MD = resolve(import.meta.dirname, 'report.md')

export type Verdict = 'BOUND' | 'UNBOUND' | 'MISMATCHED' | 'N/A' | 'UNRESOLVED' | 'NO_SERVER_ROUTE'

export interface FieldDiff {
  missingOnClient: string[] // present in the schema, absent from the client's hand-written shape
  extraOnClient: string[] // present on the client, not in the schema
}

export interface TypeBinding {
  verdict: Verdict
  clientType?: string
  schemaIdent?: string
  schemaTypeAlias?: string // the exported `type X = z.infer<typeof schemaIdent>` name, if any
  fieldDiff?: FieldDiff
  note?: string
}

export interface BindingRow {
  functionName: string
  file: string
  line: number
  method: string
  pathPattern: string
  serverPath?: string
  body: TypeBinding
  response: TypeBinding
  unresolvedReason?: string
}

function canonicalSegments(path: string): string[] {
  return path.split('/').map(seg => (seg.startsWith(':') ? ':param' : seg))
}

function canonicalPath(path: string): string {
  return canonicalSegments(path).join('/')
}

/**
 * Strips the leading `/api` and, when the route was reached by crossing the `/hubs/:hubId`
 * hub-scoping wrapper, that wrapper prefix too — collapsing it onto the same key as its
 * schema-identical non-hub-scoped twin (both mount the same route file; see app.ts's
 * `authenticated.route('/users', ...)` vs `hubScoped.route('/users', ...)`).
 *
 * Path SHAPE alone cannot tell a wrapper-crossing route apart from a route that just
 * happens to look the same (`/hubs/:hubId/members` is hubs.ts's own sub-route, not a
 * wrapped mount) — that's why this takes `viaHubScopeWrapper` from the actual mount graph
 * (see extract-server-routes.ts) instead of pattern-matching the string.
 */
function unscopedServerPath(route: ResolvedServerRoute): string {
  const noApi = route.fullPath.startsWith('/api') ? route.fullPath.slice(4) || '/' : route.fullPath
  const segs = canonicalSegments(noApi)
  if (route.viaHubScopeWrapper && segs[1] === 'hubs' && segs[2] === ':param') {
    return ['', ...segs.slice(3)].join('/') || '/'
  }
  return canonicalPath(noApi)
}

/**
 * Server routes keyed by `METHOD /unscoped/path`. A route file mounted both bare and under
 * `/hubs/:hubId` produces two entries per route; most are schema-identical, but a file may
 * register DIFFERENT handlers per mount (`/settings/roles` validates `createRoleSchema` bare
 * and `createHubRoleSchema` under a hub). `hubScoped` keeps the hub-mounted variant apart so a
 * client path that names a hub is checked against the schema that mount actually validates.
 */
interface ServerIndex {
  any: Map<string, ResolvedServerRoute>
  hubScoped: Map<string, ResolvedServerRoute>
}

function buildServerIndex(routes: ResolvedServerRoute[]): ServerIndex {
  const any = new Map<string, ResolvedServerRoute>()
  const hubScoped = new Map<string, ResolvedServerRoute>()
  for (const route of routes) {
    const key = `${route.method.toUpperCase()} ${unscopedServerPath(route)}`
    // Keep the first of the structurally identical twins.
    if (!any.has(key)) any.set(key, route)
    if (route.viaHubScopeWrapper && !hubScoped.has(key)) hubScoped.set(key, route)
  }
  return { any, hubScoped }
}

function classifyType(
  client: TypeDescriptor | undefined,
  schemaIdent: string | undefined,
  schemaIndex: ProtocolSchemaIndex,
): TypeBinding {
  if (!schemaIdent) return { verdict: 'N/A' }
  const aliases = schemaIndex.typeAliasesBySchema.get(schemaIdent) ?? []
  const schemaTypeAlias = aliases[0]
  const schemaFields = schemaIndex.resolveFields(schemaIdent)
  const schemaFile = schemaIndex.declaringFile.get(schemaIdent)
  const addAliasHint = schemaFile
    ? `add \`export type <Name> = z.infer<typeof ${schemaIdent}>\` beside it in ${relative(process.cwd(), schemaFile)}`
    : `add a PascalCase type alias for it in packages/protocol/schemas`

  if (!client) {
    return { verdict: 'UNRESOLVED', schemaIdent, schemaTypeAlias, note: 'server validates/returns a schema here but no client type could be statically determined' }
  }

  const fieldDiff: FieldDiff | undefined = schemaFields && client.fields
    ? {
      missingOnClient: schemaFields.filter(f => !client.fields!.includes(f)),
      extraOnClient: client.fields.filter(f => !schemaFields.includes(f)),
    }
    : undefined

  if (client.isInline) {
    return {
      verdict: 'UNBOUND',
      clientType: client.text,
      schemaIdent,
      schemaTypeAlias,
      fieldDiff,
      note: schemaTypeAlias
        ? `hand-written shape; protocol already exports \`${schemaTypeAlias}\` for this schema — import it instead`
        : `hand-written shape; no PascalCase type alias exists yet for \`${schemaIdent}\` — ${addAliasHint}`,
    }
  }

  if (client.importedFrom && /^@protocol\/schemas/.test(client.importedFrom)) {
    if (aliases.includes(client.text)) {
      return { verdict: 'BOUND', clientType: client.text, schemaIdent, schemaTypeAlias: client.text }
    }
    return {
      verdict: 'MISMATCHED',
      clientType: client.text,
      schemaIdent,
      schemaTypeAlias,
      fieldDiff,
      note: schemaTypeAlias
        ? `client imports \`${client.text}\` from @protocol/schemas, but this route's schema (\`${schemaIdent}\`) is aliased as \`${schemaTypeAlias}\` — likely referencing a sibling/stale schema`
        : `client imports \`${client.text}\` from @protocol/schemas, but this route's schema (\`${schemaIdent}\`) has no type alias yet to compare against — ${addAliasHint}`,
    }
  }

  return {
    verdict: 'UNBOUND',
    clientType: client.text,
    schemaIdent,
    schemaTypeAlias,
    fieldDiff,
    note: `named type \`${client.text}\` is not imported from @protocol/schemas`,
  }
}

export function buildBindingReport(): { rows: BindingRow[]; unresolvedServerMounts: string[] } {
  const { routes, unresolvedMounts } = extractServerRoutes()
  const serverIndex = buildServerIndex(routes)
  const schemaIndex = buildProtocolSchemaIndex()
  const clientCalls = extractClientCalls()

  const rows: BindingRow[] = clientCalls.map((call: ClientCall) => {
    if (call.unresolvedReason && !call.pathPattern) {
      return {
        functionName: call.functionName, file: call.file, line: call.line,
        method: call.method, pathPattern: call.pathPattern,
        body: { verdict: 'UNRESOLVED' }, response: { verdict: 'UNRESOLVED' },
        unresolvedReason: call.unresolvedReason,
      }
    }

    // A client path that manually embeds a hub id (`/hubs/${hubId}/onboard`, not routed
    // through `hp()`) is shape-identical to a genuine hub-scoped-wrapper route. Try the
    // literal path first (covers hubs.ts's own `/:hubId/members` sub-routes), then fall
    // back to the wrapper-stripped form (covers every router mounted under `hubScoped`).
    const literalPath = canonicalPath(call.pathPattern)
    const hubStripped = /^\/hubs\/:param(\/.*)?$/.exec(literalPath)
    const candidateKeys = [`${call.method} ${literalPath}`]
    if (hubStripped) candidateKeys.push(`${call.method} ${hubStripped[1] || '/'}`)

    const key = candidateKeys.find(k => serverIndex.any.has(k)) ?? candidateKeys[0]
    // A client call that is hub-scoped (names a hub, or goes through hp()/activeHubPath()/hubPath()) is served by the hub-mounted variant when there is one.
    const serverRoute = ((hubStripped || call.hubScoped) && serverIndex.hubScoped.get(key)) || serverIndex.any.get(key)
    if (!serverRoute) {
      return {
        functionName: call.functionName, file: call.file, line: call.line,
        method: call.method, pathPattern: call.pathPattern,
        body: { verdict: 'NO_SERVER_ROUTE' }, response: { verdict: 'NO_SERVER_ROUTE' },
        unresolvedReason: call.unresolvedReason ?? `no server route matched key "${key}"`,
      }
    }

    const responseSchema = serverRoute.responses.find(r => r.status.startsWith('2'))?.schema ??
      serverRoute.responses[0]?.schema
    // An inline `z.object({...})` used directly as a route schema (rare — one known instance:
    // GET /settings/users/:id/effective-permissions) has no identifier to index by.
    const responseSchemaIdent = responseSchema && /^[A-Za-z_$][\w$]*$/.test(responseSchema) ? responseSchema : undefined

    return {
      functionName: call.functionName,
      file: call.file,
      line: call.line,
      method: call.method,
      pathPattern: call.pathPattern,
      serverPath: serverRoute.fullPath,
      body: classifyType(call.bodyType, serverRoute.bodySchema, schemaIndex),
      response: classifyType(call.responseType, responseSchemaIdent, schemaIndex),
      unresolvedReason: call.unresolvedReason,
    }
  })

  return { rows, unresolvedServerMounts: unresolvedMounts }
}

/**
 * Escapes a value for safe interpolation into a generated markdown table cell
 * (or any other line-oriented markdown construct built by string concatenation
 * in this file). Order matters: backslashes must be escaped FIRST, otherwise
 * the backslash inserted to escape a pipe gets re-escaped into `\\|`, which
 * renders as a literal backslash followed by a column break — the exact
 * "incomplete sanitization" shape CodeQL flags. Newlines/carriage returns are
 * collapsed to a space since a raw newline ends a markdown table row (or, in
 * the bullet-list sections, prematurely ends the list item).
 *
 * Every interpolated field in every generated row — not just free-text notes —
 * must go through this, since any of them can (in principle) contain a pipe
 * or newline and corrupt the table.
 */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ')
}

function verdictCounts(rows: BindingRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    for (const v of [row.body.verdict, row.response.verdict]) {
      counts[v] = (counts[v] ?? 0) + 1
    }
  }
  return counts
}

export function renderMarkdown(rows: BindingRow[], unresolvedServerMounts: string[]): string {
  const counts = verdictCounts(rows)
  const lines: string[] = []
  lines.push('# API route -> schema binding report')
  lines.push('')
  lines.push('Generated by `bun scripts/api-schema-binding/bind-report.ts`. Deterministic — re-running')
  lines.push('against the same source produces byte-identical output. Do not hand-edit; regenerate.')
  lines.push('')
  lines.push('## Summary (counts include both body and response verdicts)')
  lines.push('')
  lines.push('| Verdict | Count |')
  lines.push('|---|---|')
  for (const [verdict, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${escapeMarkdownCell(verdict)} | ${escapeMarkdownCell(String(count))} |`)
  }
  lines.push('')
  lines.push(`Client functions analyzed: **${rows.length}**`)
  lines.push(`Server mount targets that could not be statically resolved: **${unresolvedServerMounts.length}**`)
  if (unresolvedServerMounts.length) {
    lines.push('')
    for (const m of unresolvedServerMounts) lines.push(`- ${m}`)
  }
  lines.push('')
  lines.push('## Per-function bindings')
  lines.push('')
  lines.push('| Function | File:Line | Method | Path | Body verdict | Response verdict | Notes |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of [...rows].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const notes = [row.body.note, row.response.note, row.unresolvedReason].filter(Boolean).join('<br>')
    const fileLine = escapeMarkdownCell(`${row.file}:${row.line}`)
    lines.push(
      `| \`${escapeMarkdownCell(row.functionName)}\` | ${fileLine} | ${escapeMarkdownCell(row.method)} | ` +
        `\`${escapeMarkdownCell(row.pathPattern || '?')}\` | ${escapeMarkdownCell(row.body.verdict)} | ` +
        `${escapeMarkdownCell(row.response.verdict)} | ${escapeMarkdownCell(notes)} |`
    )
  }
  lines.push('')
  lines.push('## Field-level diffs (schema fields vs. hand-written client shape)')
  lines.push('')
  const withDiff = rows.filter(r => (r.body.fieldDiff && (r.body.fieldDiff.missingOnClient.length || r.body.fieldDiff.extraOnClient.length)) ||
    (r.response.fieldDiff && (r.response.fieldDiff.missingOnClient.length || r.response.fieldDiff.extraOnClient.length)))
  if (withDiff.length === 0) {
    lines.push('_none resolvable_')
  }
  for (const row of withDiff) {
    for (const [label, binding] of [['body', row.body], ['response', row.response]] as const) {
      if (!binding.fieldDiff) continue
      const { missingOnClient, extraOnClient } = binding.fieldDiff
      if (!missingOnClient.length && !extraOnClient.length) continue
      lines.push(`- \`${escapeMarkdownCell(row.functionName)}\` (${label}, schema \`${escapeMarkdownCell(binding.schemaIdent ?? '')}\`):`)
      if (missingOnClient.length)
        lines.push(`  - missing on client: ${missingOnClient.map(f => `\`${escapeMarkdownCell(f)}\``).join(', ')}`)
      if (extraOnClient.length)
        lines.push(`  - extra on client (not in schema): ${extraOnClient.map(f => `\`${escapeMarkdownCell(f)}\``).join(', ')}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * What `--check` enforces: the committed report matches the source it was generated from,
 * and no client function in `src/client/lib/api/**` hand-writes (UNBOUND) or mis-binds
 * (MISMATCHED) a request/response shape. Every other verdict — BOUND, N/A, UNRESOLVED,
 * NO_SERVER_ROUTE — is informational: NO_SERVER_ROUTE is a client path with no mounted
 * route, tracked by its own issue rather than by this ratchet.
 */
export function evaluateCheck(): { stale: boolean; unbound: number; mismatched: number } {
  const { rows, unresolvedServerMounts } = buildBindingReport()
  const json = JSON.stringify({ rows, unresolvedServerMounts }, null, 2) + '\n'
  const md = renderMarkdown(rows, unresolvedServerMounts)
  const counts = verdictCounts(rows)
  return {
    stale: existsOrEmpty(REPORT_JSON) !== json || existsOrEmpty(REPORT_MD) !== md,
    unbound: counts.UNBOUND ?? 0,
    mismatched: counts.MISMATCHED ?? 0,
  }
}

function main() {
  const args = process.argv.slice(2)

  if (args.includes('--check')) {
    const { stale, unbound, mismatched } = evaluateCheck()
    if (stale) {
      console.error('api-schema-binding report is stale. Run `bun scripts/api-schema-binding/bind-report.ts` and commit the result.')
    }
    if (unbound > 0 || mismatched > 0) {
      console.error(`api-schema-binding: ${unbound} UNBOUND and ${mismatched} MISMATCHED client shape(s) in src/client/lib/api/** — bind them to @protocol/schemas (see report.md).`)
    }
    if (stale || unbound > 0 || mismatched > 0) process.exit(1)
    console.log('api-schema-binding report is up to date: 0 UNBOUND, 0 MISMATCHED.')
    return
  }

  const { rows, unresolvedServerMounts } = buildBindingReport()
  const json = JSON.stringify({ rows, unresolvedServerMounts }, null, 2) + '\n'
  const md = renderMarkdown(rows, unresolvedServerMounts)

  if (!args.includes('--summary')) {
    writeFileSync(REPORT_JSON, json)
    writeFileSync(REPORT_MD, md)
    console.log(`Wrote ${REPORT_JSON}`)
    console.log(`Wrote ${REPORT_MD}`)
  }

  const counts = verdictCounts(rows)
  console.log('\nSummary:')
  for (const [verdict, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${verdict}: ${count}`)
  }
  console.log(`\nFunctions analyzed: ${rows.length}`)
  console.log(`Unresolved server mounts: ${unresolvedServerMounts.length}`)
}

function existsOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

// Only run as a CLI — `codemod.ts` and tests import `buildBindingReport` without wanting
// report.json/report.md rewritten (or a summary printed) as a side effect of that import.
if (import.meta.main) main()
