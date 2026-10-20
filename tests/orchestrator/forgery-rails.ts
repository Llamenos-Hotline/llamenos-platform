import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The two rails that decide whether anything under `orchestrator/src` other
 * than `review-and-merge.ts` can forge a check run (#1673). They live here, not
 * inline in a test, so each can be pointed at synthetic forgeries as well as at
 * the real tree. Both return one message per violation; empty means admitted.
 *
 *  - `credentialBoundaryViolations` is the control that carries the weight. A
 *    PAT cannot create a check run; only the GitHub App's installation token
 *    can, and only `github-app.ts` can mint one. So a file that cannot import
 *    the minting surface has no credential to write a verdict with, however it
 *    spells the endpoint — `'check' + '-runs'`, a config value, an array
 *    joined at call time all produce no `check-runs` text for a text rail to
 *    see, and all are as harmless as the read without that token.
 *  - `checkRunsViolations` is defence in depth: it confines every mention of
 *    `check-runs` outside `review-and-merge.ts` to one read whose path is
 *    pinned to a validated commit SHA.
 */

export const SRC = join(process.cwd(), 'orchestrator', 'src')
export const GITHUB_APP_FILE = join(SRC, 'github-app.ts')
export const REVIEW_AND_MERGE_FILE = join(SRC, 'review-and-merge.ts')
export const GH_FILE = join(SRC, 'gh.ts')
export const MISSING_CHECKS_FILE = join(SRC, 'missing-checks.ts')

export function orchestratorSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) out.push({ file: full, text: readFileSync(full, 'utf8') })
    }
  }
  walk(SRC)
  return out
}

const rel = (file: string): string => relative(process.cwd(), file)

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
}

function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true
  return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b)
}

// ---------------------------------------------------------------------------
// The credential boundary
// ---------------------------------------------------------------------------

export const CLI_FILE = join(SRC, 'cli.ts')

/**
 * Every runtime export of `github-app.ts` that reaches the key, the JWT or the
 * installation token, or makes the authenticated request with one.
 * `fetchAppHttp` and `appApiRequest` are here although they mint nothing:
 * they are the transport the token rides on, and the review on #1673 names
 * them with `mintInstallationToken` as the three a forger reaches for.
 */
export const CREDENTIAL_EXPORTS: ReadonlySet<string> = new Set([
  'mintInstallationToken', 'appApiRequest', 'fetchAppHttp',
  'mintAppJwt', 'readRecorderCredentials', 'checkVerdictRecorder', 'reviewAppKeyPath',
  'REVIEW_APP_KEY_FILE', 'APP_ID_ENV', 'APP_KEY_PATH_ENV', 'APP_INSTALLATION_ENV',
])

/** The rest: error scrubbing and constants with no credential behind them.
 *  The two sets must partition the module's runtime exports — a new export
 *  fails the classification test until someone decides which side it is on. */
export const INERT_EXPORTS: ReadonlySet<string> = new Set([
  'GITHUB_API', 'scrubSecrets', 'VerdictRecorderError', 'describeRecorderFailure', 'githubErrorDetail',
  'REQUIRED_KEY_MODE', 'JWT_BACKDATE_SECONDS', 'JWT_LIFETIME_SECONDS', 'JWT_MAX_LIFETIME_SECONDS',
])

export interface Bound {
  module: string
  /** Which of the module's exports the bound covers. */
  covers: (name: string) => boolean
  /** The only files that may import a covered export. */
  importers: readonly string[]
  what: string
}

/**
 * The chain a verdict can be posted through, one link per row. The credential
 * is minted in `github-app.ts` and spent in `review-and-merge.ts`; that file in
 * turn EXPORTS the spending — `postReviewCheckRun`, and the deps
 * (`defaultReviewAndMergeDeps`) that carry it — so whoever imports those can
 * post a verdict without ever touching `github-app.ts`. Bounding only the
 * first link would leave the second as the forgery route.
 */
export const BOUNDS: readonly Bound[] = [
  { module: GITHUB_APP_FILE, covers: (n) => CREDENTIAL_EXPORTS.has(n), importers: [REVIEW_AND_MERGE_FILE], what: 'the GitHub App credential' },
  { module: REVIEW_AND_MERGE_FILE, covers: () => true, importers: [CLI_FILE], what: 'the check-run poster' },
]

/** Closed lists, so a module cannot be reached under a name this rail did not
 *  anticipate. A builtin that loads or evaluates code (`node:module`'s
 *  `createRequire`, `node:vm`, `node:worker_threads`) or a package that
 *  re-exports this repo's files is refused by not being on them. */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:url', 'node:util',
])
export const PACKAGES: ReadonlySet<string> = new Set(['ignore', 'yaml'])

/** Runtime exports of `github-app.ts`, read from its AST. */
export function runtimeExportsOf(file: string, text: string): string[] {
  const names: string[] = []
  for (const st of parse(file, text).statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
      names.push(...st.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text))
    }
    if (!exported) continue
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text)
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
      names.push(st.name.text)
    }
  }
  return names.sort()
}

type Resolved = { ok: true; bound: Bound | undefined } | { ok: false; why: string }

/** Where a module specifier written in `from` points, as far as this rail
 *  cares: is it a bounded module, and is it one the closed lists allow. */
function resolveSpecifier(from: string, spec: string): Resolved {
  if (spec.startsWith('node:')) return NODE_BUILTINS.has(spec) ? { ok: true, bound: undefined } : { ok: false, why: `imports the builtin ${spec}, which is not on NODE_BUILTINS` }
  let target: string
  if (spec.startsWith('.') || spec.startsWith('/')) target = resolve(dirname(from), spec)
  else if (spec.startsWith('file:')) target = fileURLToPath(spec)
  else return PACKAGES.has(spec) ? { ok: true, bound: undefined } : { ok: false, why: `imports ${JSON.stringify(spec)}, which is not on PACKAGES` }
  // A relative import that leaves orchestrator/src reaches a file no rail
  // here scans — a re-export there would launder the credential back in.
  if (!target.startsWith(SRC + sep)) return { ok: false, why: `imports ${JSON.stringify(spec)}, outside orchestrator/src` }
  const stem = target.replace(/\.(?:[mc]?[jt]sx?)$/, '')
  const candidates = [stem, `${stem}.ts`, `${stem}.js`, target]
  return { ok: true, bound: BOUNDS.find((b) => candidates.some((c) => sameFile(c, b.module))) }
}

/** Identifiers in a property-name slot (`x.eval`, `{ require: 1 }`) name a
 *  property, not the global; everything else is a value reference. */
function isPropertyName(n: ts.Identifier): boolean {
  const p = n.parent
  return (ts.isPropertyAccessExpression(p) && p.name === n) ||
    ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === n)
}

/**
 * `BOUNDS`, enforced on the AST. Every way a module is loaded is a reference
 * this walks: static `import`, `export … from`, `import x = require()`,
 * dynamic `import()`, `require()`, `import.meta.require`. Any of them with a
 * computed specifier is refused outright, because a computed specifier is a
 * module this rail cannot name. `eval`, `Function` and `globalThis` are
 * refused for the same reason: each builds a load this walk would not see.
 *
 * Toward a bounded module:
 *  - a named import of a covered export is refused outside its `importers`;
 *  - a namespace import, a default import, a dynamic import or a `require`
 *    of it is refused everywhere — each yields every export at once;
 *  - a re-export of a covered export (`export { X } from`, `export *`, or a
 *    local `export { X }` / `export default X` of the imported binding) is
 *    refused everywhere, importers included, since it would move the bound.
 * Type-only imports and exports are skipped: they are erased before run time.
 */
export function credentialBoundaryViolations(sources: { file: string; text: string }[]): string[] {
  const out: string[] = []
  for (const { file, text } of sources) {
    const sf = parse(file, text)
    const at = (n: ts.Node): string => `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
    const into = (b: Bound): string => rel(b.module)
    /** Local names bound to a covered export, and the bound they came from. */
    const coveredLocals = new Map<string, Bound>()
    const namedImportsOf = (n: ts.ImportDeclaration): { bound: Bound; els: ts.ImportSpecifier[] } | undefined => {
      if (n.importClause?.isTypeOnly || !ts.isStringLiteralLike(n.moduleSpecifier)) return undefined
      const r = resolveSpecifier(file, n.moduleSpecifier.text)
      const b = n.importClause?.namedBindings
      if (!r.ok || !r.bound || sameFile(file, r.bound.module) || !b || !ts.isNamedImports(b)) return undefined
      const bound = r.bound
      return { bound, els: b.elements.filter((el) => !el.isTypeOnly && bound.covers((el.propertyName ?? el.name).text)) }
    }
    // First pass: a local `export { X }` may precede the import that binds X.
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue
      const m = namedImportsOf(st)
      if (m) for (const el of m.els) coveredLocals.set(el.name.text, m.bound)
    }

    const load = (node: ts.Node, spec: ts.Expression | undefined, how: string): Bound | undefined => {
      if (!spec || !ts.isStringLiteralLike(spec)) {
        out.push(`${at(node)}: ${how} with a computed specifier — a module this rail cannot name`)
        return undefined
      }
      const r = resolveSpecifier(file, spec.text)
      if (!r.ok) {
        out.push(`${at(node)}: ${r.why}`)
        return undefined
      }
      return r.bound && !sameFile(file, r.bound.module) ? r.bound : undefined
    }

    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
        const b = load(n, n.moduleSpecifier, 'import')
        const clause = n.importClause
        if (b && clause) {
          if (clause.name) out.push(`${at(n)}: default-imports ${into(b)}`)
          const nb = clause.namedBindings
          if (nb && ts.isNamespaceImport(nb)) out.push(`${at(n)}: imports * from ${into(b)} — all of ${b.what} at once`)
          for (const el of namedImportsOf(n)?.els ?? []) {
            if (!b.importers.some((i) => sameFile(i, file))) {
              out.push(`${at(el)}: imports ${(el.propertyName ?? el.name).text} from ${into(b)} — ${b.what}; only ${b.importers.map(rel).join(', ')} may`)
            }
          }
        }
      } else if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
        const c = n.exportClause
        if (n.moduleSpecifier) {
          const b = load(n, n.moduleSpecifier, 'export … from')
          if (b) {
            if (!c || ts.isNamespaceExport(c)) out.push(`${at(n)}: re-exports * from ${into(b)}`)
            else for (const el of c.elements) {
              const name = (el.propertyName ?? el.name).text
              if (!el.isTypeOnly && b.covers(name)) out.push(`${at(el)}: re-exports ${name} from ${into(b)} — ${b.what}`)
            }
          }
        } else if (c && ts.isNamedExports(c)) {
          for (const el of c.elements) {
            const local = (el.propertyName ?? el.name).text
            const b = coveredLocals.get(local)
            if (!el.isTypeOnly && b) out.push(`${at(el)}: re-exports ${local} — ${b.what} from ${into(b)}`)
          }
        }
      } else if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression) && coveredLocals.has(n.expression.text)) {
        out.push(`${at(n)}: re-exports ${n.expression.text} — ${coveredLocals.get(n.expression.text)?.what ?? ''}`)
      } else if (ts.isImportEqualsDeclaration(n) && !n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) {
        const b = load(n, n.moduleReference.expression, 'import = require()')
        if (b) out.push(`${at(n)}: require()s ${into(b)} — all of ${b.what} at once`)
      } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const b = load(n, n.arguments[0], 'dynamic import()')
        if (b) out.push(`${at(n)}: dynamically imports ${into(b)} — all of ${b.what} at once`)
      } else if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
        const p = n.parent
        if (ts.isElementAccessExpression(p) || (ts.isPropertyAccessExpression(p) && p.name.text === 'require')) {
          out.push(`${at(n)}: loads a module through import.meta — use a static import`)
        }
      } else if (ts.isIdentifier(n) && !isPropertyName(n)) {
        if (n.text === 'require' || n.text === 'eval' || n.text === 'globalThis') {
          out.push(`${at(n)}: references ${n.text} — loads code this rail cannot see`)
        } else if (n.text === 'Function' && (ts.isNewExpression(n.parent) || ts.isCallExpression(n.parent)) && n.parent.expression === n) {
          out.push(`${at(n)}: constructs a Function — evaluates code this rail cannot see`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

// ---------------------------------------------------------------------------
// The check-runs text rail, pinned
// ---------------------------------------------------------------------------

/**
 * A program over one source (the real file, or a synthetic one placed at the
 * same path) and whatever it imports from disk, so an identifier can be
 * resolved to the declaration it actually names. A local
 * `const commitSha = (x) => x` shadows the import and resolves to itself.
 */
function checkerFor(file: string, text: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = {
    noLib: true, noEmit: true, types: [], allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.Latest,
  }
  const host = ts.createCompilerHost(options, true)
  const { getSourceFile, fileExists, readFile } = host
  const own = (name: string): boolean => resolve(name) === resolve(file)
  host.getSourceFile = (name, lang, ...rest) => own(name) ? ts.createSourceFile(name, text, lang, true) : getSourceFile.call(host, name, lang, ...rest)
  host.fileExists = (name) => own(name) || fileExists.call(host, name)
  host.readFile = (name) => own(name) ? text : readFile.call(host, name)
  const program = ts.createProgram([file], options, host)
  const sf = program.getSourceFile(file)
  if (!sf) throw new Error(`no source file for ${file}`)
  return { sf, checker: program.getTypeChecker() }
}

/** Whether `e` is a bare identifier naming `gh.ts`'s export `name`. */
function namesGhExport(checker: ts.TypeChecker, e: ts.Expression, name: string): boolean {
  if (!ts.isIdentifier(e)) return false
  let sym = checker.getSymbolAtLocation(e)
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
  const decl = sym?.declarations?.[0]
  return sym?.name === name && decl !== undefined && sameFile(decl.getSourceFile().fileName, GH_FILE)
}

/** The tail `/check-runs`, optionally followed by a plain query. */
const PINNED_TAIL = /^\/check-runs(?:\?[A-Za-z0-9_=&]*)?$/

/**
 * The ONE shape of check-runs read admitted outside `review-and-merge.ts`,
 * matched on the AST and on cooked (post-escape) text:
 *
 *     `repos/${REPO}/commits/${commitSha(<expr>)}/check-runs?<query>`
 *
 * untagged, with `REPO` and `commitSha` resolving to `gh.ts`'s own exports.
 * Every segment is then fixed or a validated 40-hex SHA, so the path cannot
 * resolve anywhere but `repos/{R}/commits/<sha>/check-runs` — a GET-only
 * resource; GitHub offers no create or update there.
 */
function isPinnedRead(t: ts.TemplateExpression, checker: ts.TypeChecker): boolean {
  if (ts.isTaggedTemplateExpression(t.parent)) return false
  const [repo, sha, ...rest] = t.templateSpans
  if (!repo || !sha || rest.length > 0) return false
  const call = sha.expression
  return t.head.text === 'repos/' &&
    namesGhExport(checker, repo.expression, 'REPO') && repo.literal.text === '/commits/' &&
    ts.isCallExpression(call) && !call.questionDotToken && call.arguments.length === 1 &&
    namesGhExport(checker, call.expression, 'commitSha') &&
    ts.isTemplateTail(sha.literal) && PINNED_TAIL.test(sha.literal.text)
}

const isLiteralToken = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)

/**
 * Outside `permitted` (`review-and-merge.ts`), a file may name `check-runs` —
 * in its source text, or in the cooked text of any literal (`check\-runs`,
 * `check\u002druns`) — only if it is one of `readers`, and then ONLY as the
 * tail of a pinned read. Applied to every occurrence, so a pinned read cannot
 * alibi a comment, a second literal, or a bare endpoint in the same file.
 *
 * `readers` is `missing-checks.ts` alone, not "any file with a pinned read":
 * main refuses every file but `review-and-merge.ts` that names the endpoint,
 * and this rail gives up exactly the one admission #1673 needs.
 */
export function checkRunsViolations(
  sources: { file: string; text: string }[],
  permitted: string,
  readers: readonly string[] = [MISSING_CHECKS_FILE],
): string[] {
  const out: string[] = []
  for (const { file, text } of sources) {
    if (sameFile(file, permitted)) continue
    const raw = [...text.matchAll(/check-runs/g)].map((m) => m.index)
    const quick = parse(file, text)
    let cooked = false
    const scan = (n: ts.Node): void => {
      if (isLiteralToken(n) && n.text.includes('check-runs')) cooked = true
      if (!cooked) ts.forEachChild(n, scan)
    }
    scan(quick)
    if (raw.length === 0 && !cooked) continue

    if (!readers.some((r) => sameFile(r, file))) {
      out.push(`${rel(file)}: names check-runs — only ${readers.map(rel).join(', ')} may read it, and ${rel(permitted)} write it`)
      continue
    }
    const { sf, checker } = checkerFor(file, text)
    const pinned = new Set<ts.Node>()
    const naming: ts.Node[] = []
    const visit = (n: ts.Node): void => {
      const tail = ts.isTemplateExpression(n) && isPinnedRead(n, checker) ? n.templateSpans[1]?.literal : undefined
      if (tail) pinned.add(tail)
      if (isLiteralToken(n) && n.text.includes('check-runs')) naming.push(n)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    const where = (pos: number): string => `${rel(file)}:${sf.getLineAndCharacterOfPosition(pos).line + 1}`
    for (const pos of raw) {
      const inPinned = [...pinned].some((l) => pos >= l.getStart(sf) && pos < l.getEnd())
      if (!inPinned) out.push(`${where(pos)}: check-runs outside a pinned repos/\${REPO}/commits/\${commitSha(…)}/check-runs read`)
    }
    for (const l of naming) {
      if (!pinned.has(l)) out.push(`${where(l.getStart(sf))}: a literal spells check-runs outside a pinned read`)
    }
  }
  return [...new Set(out)]
}
