#!/usr/bin/env bun
/**
 * check-migration-safety.ts — reject a migration the previous release cannot
 * run against.
 *
 * Every upgrade runs the previous release (N-1) against the schema the new one
 * (N) migrates: Helm's RollingUpdate keeps the old pod serving while the new
 * pod migrates (deploy/helm/llamenos/templates/deployment-app.yaml), and a
 * rollback boots N-1 on N's schema. Schema changes are therefore
 * expand/contract (docs/runbooks/migrations.md), and this gate enforces it in
 * three parts, all offline:
 *
 *   1. Release floor. `drizzle/compat/release-floor.json` names N-1: its
 *      version (must equal package.json's), the migration files it shipped,
 *      and its drizzle snapshot (must equal the shipped snapshot file).
 *
 *   2. Destructive-DDL lint. Every migration NOT in the floor is split with
 *      the runner's own splitter (scripts/lib/migration-statements.ts) and
 *      each statement is parsed with the real Postgres grammar (libpg_query,
 *      compiled to WASM). Judging the parse tree, not the text, is the point:
 *      `DROP` inside a comment, a string literal, a COMMENT ON or a function
 *      body is not a drop, and `alter table\n x\n drop\n column y` is. The
 *      shipped destructive files are exempt because they are in the floor,
 *      not because anyone listed them. A finding may be exempted only by a
 *      `drizzle/contract.json` entry, and the entry is VERIFIED: the floor
 *      must no longer declare the object, so N-1 no longer reads it.
 *
 *   3. Schema contract. Every column the floor snapshot declares keeps its
 *      type and nullability in the newest snapshot (widening only:
 *      varchar(n) → text, NOT NULL → nullable), enums keep their values, and
 *      every NOT NULL column a floor table gained has a default, so N-1's
 *      INSERTs, which do not name it, still succeed. An object may be
 *      "forgotten" (absent from the newest snapshot) but not dropped: see
 *      compareSchemas.
 *
 * Usage:
 *   bun scripts/check-migration-safety.ts [--ci] [--root <repo>]
 *   bun run migration:safety --ci
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  loadModule,
  parsePlPgSQLSync,
  parseSync,
  type ColumnDef,
  type Constraint,
  type Node,
  type ObjectType,
  type RangeVar,
} from '@libpg-query/parser'
import { listMigrationFiles, splitMigrationStatements } from './lib/migration-statements'
import {
  type ContractExemption,
  type DrizzleSnapshot,
  type MigrationContract,
  type ReleaseFloor,
  type SnapshotColumn,
  latestSnapshotFile,
  packageVersion,
  readJson,
  repoPaths,
} from './lib/release-floor'

const DEFAULT_SCHEMA = 'public'
const RUNBOOK = 'docs/runbooks/migrations.md'

// ── Objects ──────────────────────────────────────────────────────────────────

/** A schema object a finding is about, in the form a contract entry names it. */
export type ObjectRef =
  | { kind: 'relation'; schema: string; name: string }
  | { kind: 'column'; schema: string; table: string; column: string }
  | { kind: 'sequence'; schema: string; name: string }
  | { kind: 'type'; schema: string; name: string }
  | { kind: 'enum-value'; schema: string; type: string; value: string }
  | { kind: 'schema'; name: string }

/** `table public.users`, `column public.users.team_id`, `enum-value public.role.old` … */
export function describeObject(ref: ObjectRef): string {
  switch (ref.kind) {
    case 'relation':
      return `table ${ref.schema}.${ref.name}`
    case 'column':
      return `column ${ref.schema}.${ref.table}.${ref.column}`
    case 'sequence':
      return `sequence ${ref.schema}.${ref.name}`
    case 'type':
      return `type ${ref.schema}.${ref.name}`
    case 'enum-value':
      return `enum-value ${ref.schema}.${ref.type}.${ref.value}`
    case 'schema':
      return `schema ${ref.name}`
  }
}

const SERIAL_TYPES = new Set(['serial', 'serial4', 'bigserial', 'serial8', 'smallserial', 'serial2'])

/** Reads one snapshot the way Postgres resolves names. */
export class SchemaView {
  constructor(readonly snapshot: DrizzleSnapshot) {}

  relation(schema: string, name: string): { columns?: Record<string, SnapshotColumn> } | undefined {
    const key = `${schema}.${name}`
    return this.snapshot.tables[key] ?? this.snapshot.views?.[key]
  }

  column(schema: string, table: string, column: string): SnapshotColumn | undefined {
    return this.relation(schema, table)?.columns?.[column]
  }

  /** Explicit sequences, plus the implicit `<table>_<column>_seq` a serial column owns. */
  sequence(schema: string, name: string): boolean {
    if (this.snapshot.sequences?.[`${schema}.${name}`]) return true
    for (const t of Object.values(this.snapshot.tables)) {
      if ((t.schema || DEFAULT_SCHEMA) !== schema) continue
      for (const c of Object.values(t.columns)) {
        if (SERIAL_TYPES.has(c.type) && `${t.name}_${c.name}_seq` === name) return true
      }
    }
    return false
  }

  declares(ref: ObjectRef): boolean {
    switch (ref.kind) {
      case 'relation':
        return this.relation(ref.schema, ref.name) !== undefined
      case 'column':
        return this.column(ref.schema, ref.table, ref.column) !== undefined
      case 'sequence':
        return this.sequence(ref.schema, ref.name) || this.relation(ref.schema, ref.name) !== undefined
      case 'type':
        return this.snapshot.enums[`${ref.schema}.${ref.name}`] !== undefined
      case 'enum-value':
        return this.snapshot.enums[`${ref.schema}.${ref.type}`]?.values.includes(ref.value) ?? false
      case 'schema': {
        const inSchema = (o: { schema?: string }) => (o.schema || DEFAULT_SCHEMA) === ref.name
        return (
          Object.values(this.snapshot.schemas ?? {}).includes(ref.name) ||
          Object.values(this.snapshot.tables).some(inSchema) ||
          Object.values(this.snapshot.enums).some(inSchema) ||
          Object.values(this.snapshot.views ?? {}).some(inSchema) ||
          Object.values(this.snapshot.sequences ?? {}).some(inSchema)
        )
      }
    }
  }
}

// ── Findings ─────────────────────────────────────────────────────────────────

export type Rule =
  | 'drop'
  | 'drop-column'
  | 'rename'
  | 'set-schema'
  | 'alter-column-type'
  | 'set-not-null'
  | 'drop-default-not-null'
  | 'add-not-null-column-without-default'
  | 'add-constraint-existing'
  | 'unique-index-existing'
  | 'truncate'
  | 'delete-without-where'
  | 'dynamic-sql'
  | 'unjudgeable-do'
  | 'parse-error'

/** Why each rule breaks the previous release. Printed with every finding. */
const WHY: Record<Rule, string> = {
  drop: 'the previous release still reads it',
  'drop-column': "the previous release still reads it, and its INSERTs still name it",
  rename: 'the previous release still uses the old name',
  'set-schema': 'the previous release still uses the old schema-qualified name',
  'alter-column-type': 'the previous release reads and writes the old type',
  'set-not-null': 'the previous release may still write NULL, or omit the column on INSERT',
  'drop-default-not-null': "the previous release omits it on INSERT and relies on the default",
  'add-not-null-column-without-default':
    'the previous release does not know the column, so its INSERTs leave it NULL and fail',
  'add-constraint-existing': 'the previous release writes rows the new constraint rejects',
  'unique-index-existing': 'the previous release writes rows the new unique index rejects',
  truncate: 'it deletes every row the previous release reads',
  'delete-without-where': 'it deletes every row the previous release reads',
  'dynamic-sql': 'EXECUTE builds SQL at run time, so what it does cannot be judged before it runs',
  'unjudgeable-do': 'only LANGUAGE plpgsql DO blocks can be parsed and judged',
  'parse-error': 'Postgres would reject it too',
}

export interface Finding {
  rule: Rule
  /** Absent for findings no exemption can cover (dynamic SQL, unparseable input). */
  object?: ObjectRef
  /** e.g. "inside DO block". */
  context?: string
  detail?: string
}

export interface LintContext {
  floor: SchemaView
  current: SchemaView
}

export function lintContext(floor: DrizzleSnapshot, current: DrizzleSnapshot): LintContext {
  return { floor: new SchemaView(floor), current: new SchemaView(current) }
}

// ── Parse-tree helpers ───────────────────────────────────────────────────────

function str(node: Node | undefined): string | undefined {
  return node && 'String' in node ? node.String.sval : undefined
}

/** `[name]`, `[schema, name]` or `[db, schema, name]` → schema + name. */
function qualifiedName(names: (string | undefined)[]): { schema: string; name: string } | undefined {
  const parts = names.filter((n): n is string => n !== undefined)
  const name = parts.at(-1)
  if (name === undefined) return undefined
  return { schema: parts.at(-2) ?? DEFAULT_SCHEMA, name }
}

function listNames(node: Node | undefined): (string | undefined)[] {
  if (!node) return []
  if ('List' in node) return (node.List.items ?? []).map(str)
  if ('TypeName' in node) return (node.TypeName.names ?? []).map(str)
  if ('String' in node) return [node.String.sval]
  return []
}

function rel(r: RangeVar | undefined): { schema: string; name: string } | undefined {
  if (!r?.relname) return undefined
  return { schema: r.schemaname ?? DEFAULT_SCHEMA, name: r.relname }
}

function relationKindRef(
  objectType: ObjectType | undefined,
  target: { schema: string; name: string },
): ObjectRef | undefined {
  switch (objectType) {
    case 'OBJECT_TABLE':
    case 'OBJECT_VIEW':
    case 'OBJECT_MATVIEW':
    case 'OBJECT_FOREIGN_TABLE':
      return { kind: 'relation', ...target }
    case 'OBJECT_SEQUENCE':
      return { kind: 'sequence', ...target }
    case 'OBJECT_TYPE':
    case 'OBJECT_DOMAIN':
      return { kind: 'type', ...target }
    default:
      return undefined
  }
}

/** Every column a raw expression references by name. */
function columnRefs(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) columnRefs(v, into)
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'ColumnRef') {
        const fields = (v as { fields?: Node[] }).fields ?? []
        const last = str(fields.at(-1))
        if (last !== undefined) into.push(last)
      } else {
        columnRefs(v, into)
      }
    }
  }
  return into
}

function constraintTypes(def: ColumnDef): Set<string> {
  return new Set(
    (def.constraints ?? []).flatMap((c) => ('Constraint' in c && c.Constraint.contype ? [c.Constraint.contype] : [])),
  )
}

function addsNotNullWithoutDefault(def: ColumnDef): boolean {
  const types = constraintTypes(def)
  const notNull = types.has('CONSTR_NOTNULL') || types.has('CONSTR_PRIMARY')
  const filled = types.has('CONSTR_DEFAULT') || types.has('CONSTR_IDENTITY') || types.has('CONSTR_GENERATED')
  const typeName = str(def.typeName?.names?.at(-1))
  return notNull && !filled && !(typeName !== undefined && SERIAL_TYPES.has(typeName))
}

// ── Rules ────────────────────────────────────────────────────────────────────

function lintAlterTable(
  stmt: { relation?: RangeVar; cmds?: Node[]; objtype?: ObjectType },
  ctx: LintContext,
  out: Finding[],
): void {
  if (stmt.objtype !== 'OBJECT_TABLE' && stmt.objtype !== 'OBJECT_FOREIGN_TABLE') return
  const table = rel(stmt.relation)
  if (!table) return
  const column = (c: string): ObjectRef => ({ kind: 'column', schema: table.schema, table: table.name, column: c })
  const tableInFloor = ctx.floor.relation(table.schema, table.name) !== undefined
  const floorColumn = (c: string) => ctx.floor.column(table.schema, table.name, c)

  for (const node of stmt.cmds ?? []) {
    if (!('AlterTableCmd' in node)) continue
    const cmd = node.AlterTableCmd
    const name = cmd.name ?? ''
    switch (cmd.subtype) {
      case 'AT_DropColumn':
        out.push({ rule: 'drop-column', object: column(name) })
        break
      case 'AT_AlterColumnType':
        out.push({ rule: 'alter-column-type', object: column(name) })
        break
      case 'AT_SetNotNull':
        out.push({ rule: 'set-not-null', object: column(name) })
        break
      case 'AT_ColumnDefault': {
        // `def` absent is DROP DEFAULT; present is SET DEFAULT, which is safe.
        if (cmd.def) break
        const was = floorColumn(name)
        const now = ctx.current.column(table.schema, table.name, name)
        if (was && (was.notNull || now?.notNull)) {
          out.push({ rule: 'drop-default-not-null', object: column(name) })
        }
        break
      }
      case 'AT_AddColumn': {
        const def = cmd.def && 'ColumnDef' in cmd.def ? cmd.def.ColumnDef : undefined
        if (def?.colname && tableInFloor && addsNotNullWithoutDefault(def)) {
          out.push({ rule: 'add-not-null-column-without-default', object: column(def.colname) })
        }
        break
      }
      case 'AT_AddConstraint': {
        const con = cmd.def && 'Constraint' in cmd.def ? cmd.def.Constraint : undefined
        if (!con || !tableInFloor) break
        const hit = existingConstraintColumn(con, floorColumn)
        if (hit === null) break
        out.push({
          rule: 'add-constraint-existing',
          object: hit === undefined ? { kind: 'relation', ...table } : column(hit),
          detail: con.contype,
        })
        break
      }
    }
  }
}

/**
 * Which column the previous release already writes does this constraint bind?
 * A column name; `undefined` when it binds the table as a whole or cannot be
 * told (USING INDEX, EXCLUDE); `null` when it binds only columns the floor
 * does not declare (N-1 leaves those NULL, which UNIQUE, FK and CHECK all
 * accept), or the constraint type cannot reject a write.
 */
function existingConstraintColumn(
  con: Constraint,
  floorColumn: (c: string) => SnapshotColumn | undefined,
): string | undefined | null {
  const firstExisting = (cols: string[]) => cols.find((c) => floorColumn(c) !== undefined) ?? null
  switch (con.contype) {
    case 'CONSTR_UNIQUE':
    case 'CONSTR_PRIMARY':
      if (con.indexname) return undefined
      return firstExisting((con.keys ?? []).map(str).filter((c): c is string => c !== undefined))
    case 'CONSTR_FOREIGN':
      return firstExisting((con.fk_attrs ?? []).map(str).filter((c): c is string => c !== undefined))
    case 'CONSTR_CHECK':
      return firstExisting(columnRefs(con.raw_expr))
    case 'CONSTR_EXCLUSION':
      return undefined
    default:
      return null
  }
}

function lintNode(key: string, value: unknown, ctx: LintContext, out: Finding[]): void {
  switch (key) {
    case 'AlterTableStmt':
      lintAlterTable(value as Parameters<typeof lintAlterTable>[0], ctx, out)
      return
    case 'DropStmt': {
      const s = value as { objects?: Node[]; removeType?: ObjectType }
      for (const obj of s.objects ?? []) {
        if (s.removeType === 'OBJECT_SCHEMA') {
          const name = str(obj)
          if (name !== undefined) out.push({ rule: 'drop', object: { kind: 'schema', name } })
          continue
        }
        const target = qualifiedName(listNames(obj))
        const ref = target && relationKindRef(s.removeType, target)
        if (ref) out.push({ rule: 'drop', object: ref })
      }
      return
    }
    case 'RenameStmt': {
      const s = value as {
        renameType?: ObjectType
        relation?: RangeVar
        object?: Node
        subname?: string
      }
      if (s.renameType === 'OBJECT_COLUMN') {
        const t = rel(s.relation)
        if (t && s.subname) {
          out.push({ rule: 'rename', object: { kind: 'column', schema: t.schema, table: t.name, column: s.subname } })
        }
        return
      }
      if (s.renameType === 'OBJECT_SCHEMA') {
        if (s.subname) out.push({ rule: 'rename', object: { kind: 'schema', name: s.subname } })
        return
      }
      const target = rel(s.relation) ?? qualifiedName(listNames(s.object))
      const ref = target && relationKindRef(s.renameType, target)
      if (ref) out.push({ rule: 'rename', object: ref })
      return
    }
    case 'AlterEnumStmt': {
      // ADD VALUE is additive; RENAME VALUE carries oldVal.
      const s = value as { typeName?: Node[]; oldVal?: string }
      const t = qualifiedName((s.typeName ?? []).map(str))
      if (t && s.oldVal) {
        out.push({ rule: 'rename', object: { kind: 'enum-value', schema: t.schema, type: t.name, value: s.oldVal } })
      }
      return
    }
    case 'AlterObjectSchemaStmt': {
      const s = value as { objectType?: ObjectType; relation?: RangeVar; object?: Node }
      const target = rel(s.relation) ?? qualifiedName(listNames(s.object))
      const ref = target && relationKindRef(s.objectType, target)
      if (ref) out.push({ rule: 'set-schema', object: ref })
      return
    }
    case 'IndexStmt': {
      const s = value as { unique?: boolean; relation?: RangeVar; indexParams?: Node[] }
      const t = rel(s.relation)
      if (!s.unique || !t || !ctx.floor.relation(t.schema, t.name)) return
      const cols = (s.indexParams ?? []).flatMap((p) =>
        'IndexElem' in p ? (p.IndexElem.name ? [p.IndexElem.name] : columnRefs(p.IndexElem.expr)) : [],
      )
      const hit = cols.find((c) => ctx.floor.column(t.schema, t.name, c) !== undefined)
      if (hit) {
        out.push({ rule: 'unique-index-existing', object: { kind: 'column', schema: t.schema, table: t.name, column: hit } })
      }
      return
    }
    case 'TruncateStmt': {
      const s = value as { relations?: Node[] }
      for (const r of s.relations ?? []) {
        const t = 'RangeVar' in r ? rel(r.RangeVar) : undefined
        if (t) out.push({ rule: 'truncate', object: { kind: 'relation', ...t } })
      }
      return
    }
    case 'DeleteStmt': {
      const s = value as { relation?: RangeVar; whereClause?: Node }
      const t = rel(s.relation)
      if (t && !s.whereClause) out.push({ rule: 'delete-without-where', object: { kind: 'relation', ...t } })
      return
    }
    case 'DoStmt':
      lintDoBlock(value as { args?: Node[] }, ctx, out)
      return
  }
}

/**
 * Subtrees that are definitions, not actions: a function body or a rule's
 * actions run later, when called or triggered, not when the migration runs.
 * (A plpgsql function body is a string the parser does not descend into
 * anyway; a SQL-standard `BEGIN ATOMIC` body is parsed into nodes, so it has
 * to be skipped here.)
 */
const DEFINITION_NODES = new Set(['CreateFunctionStmt', 'RuleStmt'])

/** Walk a parse tree, judging every executable node at any depth (e.g. a DELETE inside a CTE). */
function walk(value: unknown, ctx: LintContext, out: Finding[]): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, ctx, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (DEFINITION_NODES.has(key)) continue
    lintNode(key, child, ctx, out)
    walk(child, ctx, out)
  }
}

/** Parse and judge one chunk of SQL (one runner statement, or one statement inside a DO block). */
export function lintSql(sql: string, ctx: LintContext, context?: string): Finding[] {
  let tree: unknown
  try {
    tree = parseSync(sql)
  } catch (err) {
    return [{ rule: 'parse-error', context, detail: err instanceof Error ? err.message : String(err) }]
  }
  const out: Finding[] = []
  walk(tree, ctx, out)
  return context === undefined ? out : out.map((f) => ({ ...f, context: f.context ?? context }))
}

/** plpgsql statement kinds whose SQL is built at run time. */
const DYNAMIC_PLPGSQL = new Set(['PLpgSQL_stmt_dynexecute', 'PLpgSQL_stmt_dynfors'])

/**
 * A DO block runs its body now, so the body is judged too: parsed with the
 * plpgsql grammar, every embedded SQL statement is judged like a top-level
 * one, and EXECUTE of a run-time string fails, because no parser can see it.
 */
function lintDoBlock(stmt: { args?: Node[] }, ctx: LintContext, out: Finding[]): void {
  let language = 'plpgsql'
  let body: string | undefined
  for (const a of stmt.args ?? []) {
    if (!('DefElem' in a)) continue
    const v = str(a.DefElem.arg)
    if (a.DefElem.defname === 'language' && v !== undefined) language = v.toLowerCase()
    if (a.DefElem.defname === 'as') body = v
  }
  if (language !== 'plpgsql' || body === undefined) {
    out.push({ rule: 'unjudgeable-do', detail: `LANGUAGE ${language}` })
    return
  }
  // libpg_query parses plpgsql from a CREATE FUNCTION. The dollar-quote tag
  // is chosen so it cannot occur in the body.
  let tag = 'do_body'
  while (body.includes(`$${tag}$`)) tag += '_'
  let tree: unknown
  try {
    tree = parsePlPgSQLSync(
      `CREATE FUNCTION pg_temp.migration_safety_do() RETURNS void LANGUAGE plpgsql AS $${tag}$${body}$${tag}$`,
    )
  } catch (err) {
    out.push({ rule: 'parse-error', context: 'inside DO block', detail: err instanceof Error ? err.message : String(err) })
    return
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (DYNAMIC_PLPGSQL.has(key) || key === 'dynquery') {
        out.push({ rule: 'dynamic-sql', context: 'inside DO block' })
        continue
      }
      if (key === 'PLpgSQL_expr') {
        // parseMode 0 (RAW_PARSE_DEFAULT) is a whole SQL statement; the other
        // modes are expressions and assignments, which cannot hold DDL.
        const expr = child as { query?: string; parseMode?: number }
        if ((expr.parseMode ?? 0) === 0 && expr.query) out.push(...lintSql(expr.query, ctx, 'inside DO block'))
        continue
      }
      visit(child)
    }
  }
  visit(tree)
}

// ── The gate ─────────────────────────────────────────────────────────────────

export interface Violation {
  file?: string
  statementIndex?: number
  message: string
}

export interface SafetyReport {
  floorVersion: string
  judgedFiles: string[]
  exempted: number
  violations: Violation[]
}

interface Located extends Finding {
  file: string
  statementIndex: number
}

function locate(f: Located): string {
  return `${f.file} statement ${f.statementIndex}${f.context ? ` (${f.context})` : ''}`
}

function findingMessage(f: Located): string {
  const what = f.object ? `${f.rule} ${describeObject(f.object)}` : f.rule
  const detail = f.detail ? ` [${f.detail}]` : ''
  return `${locate(f)}: ${what}${detail}: ${WHY[f.rule]}. Use expand/contract (${RUNBOOK}).`
}

const WIDENINGS: ReadonlyArray<(from: string, to: string) => boolean> = [
  (from, to) => /^varchar\(\d+\)$/.test(from) && to === 'text',
]

/** A column an INSERT may omit: the database fills it. */
function filledByDatabase(c: SnapshotColumn): boolean {
  return (
    !c.notNull ||
    c.default !== undefined ||
    c.identity !== undefined ||
    c.generated !== undefined ||
    SERIAL_TYPES.has(c.type)
  )
}

/**
 * Part 3: the newest snapshot against the floor's.
 *
 * An object the floor declares may be absent from the newest snapshot: that
 * is "forgetting" it, the step before contracting it. The code stops
 * declaring it while the database keeps it, so the previous release still
 * finds it — part 2 rejects every judged statement that would physically drop
 * or rename it while the floor declares it. Without this, an object that ever
 * shipped could never be dropped: the exemption for its DROP is verified
 * against a floor that must no longer declare it.
 *
 * What may not happen to an object the floor declares and the newest snapshot
 * still has: a type change other than a listed widening, a nullable column
 * becoming NOT NULL, an enum losing a value.
 */
export function compareSchemas(floor: DrizzleSnapshot, current: DrizzleSnapshot): string[] {
  const problems: string[] = []
  for (const [key, table] of Object.entries(floor.tables)) {
    const cur = current.tables[key]
    if (!cur) continue
    for (const [name, col] of Object.entries(table.columns)) {
      const c = cur.columns[name]
      if (!c) {
        // Forgotten. This tree's INSERTs no longer name it, so the database
        // has to be able to fill it.
        if (!filledByDatabase(col)) {
          problems.push(
            `column ${key}.${name} is no longer declared but is NOT NULL with no default, so this ` +
              "release's INSERTs, which omit it, fail. Drop its NOT NULL or give it a default in the " +
              'release before the one that stops declaring it',
          )
        }
        continue
      }
      if (c.type !== col.type && !WIDENINGS.some((w) => w(col.type, c.type))) {
        problems.push(`column ${key}.${name} changed type ${col.type} → ${c.type}`)
      }
      if (!col.notNull && c.notNull) {
        problems.push(`column ${key}.${name} became NOT NULL`)
      }
    }
    for (const [name, c] of Object.entries(cur.columns)) {
      if (table.columns[name] || filledByDatabase(c)) continue
      problems.push(
        `column ${key}.${name} is NOT NULL with no default on a table the release floor declares — ` +
          "the previous release's INSERTs do not name it",
      )
    }
  }
  for (const [key, e] of Object.entries(floor.enums)) {
    const cur = current.enums[key]
    if (!cur) continue
    for (const v of e.values) {
      if (!cur.values.includes(v)) problems.push(`enum ${key} lost value '${v}'`)
    }
  }
  return problems
}

function validateContract(contract: MigrationContract): string[] {
  const problems: string[] = []
  if (!Array.isArray(contract.exemptions)) return ['drizzle/contract.json: `exemptions` must be an array']
  contract.exemptions.forEach((e: Partial<ContractExemption>, i) => {
    const at = `drizzle/contract.json exemptions[${i}]`
    if (typeof e.file !== 'string' || !e.file.endsWith('.sql')) problems.push(`${at}: \`file\` must name a .sql migration`)
    if (!Number.isInteger(e.statementIndex) || (e.statementIndex ?? -1) < 0) {
      problems.push(`${at}: \`statementIndex\` must be a non-negative integer`)
    }
    if (typeof e.object !== 'string' || e.object.length === 0) problems.push(`${at}: \`object\` is required`)
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) problems.push(`${at}: \`reason\` is required`)
  })
  return problems
}

export async function checkMigrationSafety(root: string): Promise<SafetyReport> {
  await loadModule()
  const paths = repoPaths(root)
  const violations: Violation[] = []

  // ── 1. Release floor ──────────────────────────────────────────────────────
  const floor = readJson<ReleaseFloor>(paths.floor)
  const version = packageVersion(paths.packageJson)
  if (floor.version !== version) {
    violations.push({
      message:
        `drizzle/compat/release-floor.json records ${floor.version} but package.json is ${version}. ` +
        "The floor is written by knope's prepare-release (scripts/record-release-floor.ts) in the " +
        'same commit that bumps the version; never by hand.',
    })
  }
  const files = listMigrationFiles(paths.migrationsDir)
  const present = new Set(files)
  for (const f of floor.migrations) {
    if (!present.has(f)) {
      violations.push({ file: f, message: `${f} shipped in ${floor.version} but is gone. Shipped migrations are never deleted.` })
    }
  }
  let shippedSnapshot: DrizzleSnapshot | undefined
  try {
    shippedSnapshot = readJson<DrizzleSnapshot>(join(paths.metaDir, floor.snapshotFile))
  } catch {
    violations.push({ message: `the floor's snapshot file meta/${floor.snapshotFile} is missing` })
  }
  if (shippedSnapshot && !isDeepStrictEqual(shippedSnapshot, floor.snapshot)) {
    violations.push({
      message:
        `drizzle/compat/release-floor.json's snapshot differs from meta/${floor.snapshotFile}, the ` +
        `snapshot ${floor.version} shipped. A released snapshot is as immutable as a released migration.`,
    })
  }

  const floorFiles = new Set(floor.migrations)
  const judgedFiles = files.filter((f) => !floorFiles.has(f))
  const lastShipped = [...floor.migrations].sort().at(-1) ?? ''
  for (const f of judgedFiles) {
    if (f < lastShipped) {
      violations.push({
        file: f,
        message:
          `${f} sorts before ${lastShipped}, which ${floor.version} already shipped. An upgraded ` +
          'database would apply it last but a fresh one in the middle; name it after the newest shipped file.',
      })
    }
  }

  // ── 2. Destructive-DDL lint ───────────────────────────────────────────────
  const current = readJson<DrizzleSnapshot>(join(paths.metaDir, latestSnapshotFile(paths.metaDir)))
  const ctx = lintContext(floor.snapshot, current)
  const findings: Located[] = []
  for (const file of judgedFiles) {
    const statements = splitMigrationStatements(readFileSync(join(paths.migrationsDir, file), 'utf-8'))
    statements.forEach((sql, statementIndex) => {
      for (const f of lintSql(sql, ctx)) findings.push({ ...f, file, statementIndex })
    })
  }

  const contract = readJson<MigrationContract>(paths.contract)
  const shapeProblems = validateContract(contract)
  for (const message of shapeProblems) violations.push({ message })
  const exempted = new Set<Located>()
  if (shapeProblems.length === 0) {
    for (const e of contract.exemptions) {
      const at = `drizzle/contract.json entry {${e.file}, ${e.statementIndex}, ${e.object}}`
      if (floorFiles.has(e.file)) {
        violations.push({ file: e.file, message: `${at}: ${e.file} shipped in ${floor.version}; the entry is stale, remove it.` })
        continue
      }
      const matches = findings.filter(
        (f) => f.file === e.file && f.statementIndex === e.statementIndex && f.object && describeObject(f.object) === e.object,
      )
      if (matches.length === 0) {
        violations.push({ file: e.file, message: `${at}: matches no finding. An exemption must name a statement this lint rejects.` })
        continue
      }
      const object = matches[0].object as ObjectRef
      if (ctx.floor.declares(object)) {
        violations.push({
          file: e.file,
          statementIndex: e.statementIndex,
          message:
            `${at}: rejected — release floor ${floor.version} still declares ${e.object}, so the previous ` +
            'release still reads it. Contract it in a release after the one that stops using it.',
        })
        continue
      }
      for (const m of matches) exempted.add(m)
    }
  }
  for (const f of findings) {
    if (!exempted.has(f)) violations.push({ file: f.file, statementIndex: f.statementIndex, message: findingMessage(f) })
  }

  // ── 3. Schema contract ────────────────────────────────────────────────────
  for (const message of compareSchemas(floor.snapshot, current)) {
    violations.push({ message: `schema contract vs ${floor.version}: ${message}` })
  }

  return { floorVersion: floor.version, judgedFiles, exempted: exempted.size, violations }
}

if (import.meta.main) {
  const ci = process.argv.includes('--ci')
  const i = process.argv.indexOf('--root')
  const root = i === -1 ? join(import.meta.dir, '..') : process.argv[i + 1]
  if (root === undefined) {
    console.error('--root needs a directory')
    process.exit(2)
  }
  const report = await checkMigrationSafety(root)
  console.log(
    `[migration-safety] judged ${report.judgedFiles.length} new migration file(s) against release floor ` +
      `${report.floorVersion}${report.judgedFiles.length ? `: ${report.judgedFiles.join(', ')}` : ''}` +
      (report.exempted ? `; ${report.exempted} finding(s) exempted by drizzle/contract.json` : ''),
  )
  for (const v of report.violations) {
    if (ci) {
      const file = v.file ? ` file=drizzle/migrations/${v.file}` : ''
      console.log(`::error${file}::${v.message}`)
    } else {
      console.error(`  ✗ ${v.message}`)
    }
  }
  if (report.violations.length > 0) {
    console.error(`[migration-safety] FAILED — ${report.violations.length} violation(s)`)
    process.exit(1)
  }
  console.log('[migration-safety] OK')
}
