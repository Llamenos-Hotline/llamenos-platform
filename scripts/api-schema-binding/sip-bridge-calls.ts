/**
 * sip-bridge-calls.ts — the webhooks `sip-bridge/` posts to the worker.
 *
 * The bridge's only worker-facing calls go through `post()` →
 * `WebhookSender.sendWebhookForCommands()` → `sendWebhook()`, whose fetch is a
 * signed `POST`. Paths come from two constant tables in `types.ts`
 * (`WORKER_PATHS`, `CALLBACK_PATHS`); a callback is chosen at runtime by
 * event name (`CALLBACK_PATHS[gather.callbackEvent]`), so that one site is
 * checked against every value in the table. The bridge's other `fetch()`
 * calls go to the PBX (ARI, Kamailio JSON-RPC), not to the worker.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import type { CallSite } from './contract-match'
import { toSites, unres, union, type Res } from './path-shared'

export interface BridgeFile {
  file: string
  raw: string
}

export function readBridgeSources(root: string, cwd: string): BridgeFile[] {
  const out: BridgeFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push({ file: relative(cwd, full), raw: readFileSync(full, 'utf-8') })
    }
  }
  walk(root)
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/** Methods that take the worker path as their first argument. */
const SENDERS = new Set(['post', 'sendWebhookForCommands', 'sendWebhook'])

const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression
  return e
}

export function extractBridgeCalls(files: BridgeFile[]): CallSite[] {
  const parsed = files.map(f => ({ f, sf: ts.createSourceFile(f.file, f.raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }))

  // NAME -> { key -> value } for `const NAME = { key: '/api/…' } as const`.
  const tables = new Map<string, Map<string, string>>()
  for (const { sf } of parsed) {
    sf.forEachChild(function visit(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = strip(n.initializer)
        if (ts.isObjectLiteralExpression(init)) {
          const table = new Map<string, string>()
          for (const p of init.properties) {
            if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ts.isStringLiteral(strip(p.initializer))) {
              table.set(p.name.text, (strip(p.initializer) as ts.StringLiteral).text)
            }
          }
          if (table.size) tables.set(n.name.text, table)
        }
      }
      ts.forEachChild(n, visit)
    })
  }

  // The verb the sender's fetch uses, read from its options rather than assumed.
  let verb: Res = unres('webhook-sender.ts has no fetch() with a literal method')
  for (const { f, sf } of parsed) {
    if (!f.file.endsWith('webhook-sender.ts')) continue
    sf.forEachChild(function visit(n) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch' && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
        for (const p of n.arguments[1].properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method' && ts.isStringLiteral(p.initializer)) {
            verb = { alts: [{ path: p.initializer.text, scoping: 'none' }] }
          }
        }
      }
      ts.forEachChild(n, visit)
    })
  }

  const evalPath = (e0: ts.Expression): Res => {
    const e = strip(e0)
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { alts: [{ path: e.text, scoping: 'none' }] }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const value = tables.get(e.expression.text)?.get(e.name.text)
      return value === undefined ? unres(`\`${e.getText()}\` is not an entry of a constant table`) : { alts: [{ path: value, scoping: 'none' }] }
    }
    if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const table = tables.get(e.expression.text)
      if (table) return union([...table.values()].map(v => ({ alts: [{ path: v, scoping: 'none' as const }] })))
    }
    return unres(`unsupported expression \`${e.getText().slice(0, 40)}\``)
  }

  const sites: CallSite[] = []
  for (const { f, sf } of parsed) {
    sf.forEachChild(function visit(n) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && SENDERS.has(n.expression.name.text) && n.arguments[0]) {
        const arg0 = n.arguments[0]
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        // Pass-through: a sender forwarding its own `path` parameter to the next sender down.
        let fn: ts.Node | undefined = n.parent
        while (fn && !ts.isMethodDeclaration(fn) && !ts.isFunctionDeclaration(fn)) fn = fn.parent
        const own =
          !!fn && (ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) && ts.isIdentifier(arg0) &&
          SENDERS.has(fn.name?.getText() ?? '') && fn.parameters.some(p => p.name.getText() === arg0.text)
        const res = evalPath(arg0)
        sites.push(...toSites({ client: 'sip-bridge', file: f.file, line, kind: 'call' }, verb, res, arg0.getText(sf).replace(/\s+/g, ' '), own))
      }
      ts.forEachChild(n, visit)
    })
  }
  return sites
}
