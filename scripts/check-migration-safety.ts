#!/usr/bin/env bun
/**
 * check-migration-safety.ts: reject a migration the previous release cannot
 * run against.
 *
 * Every upgrade runs the previous release (N-1) against the schema the new one
 * (N) migrates. Migrations run from the image entrypoint on every container
 * start (deploy/docker/docker-entrypoint.sh): Helm's RollingUpdate keeps the
 * old pod serving while the new pod migrates, and a rollback boots N-1 on N's
 * schema. Schema changes are therefore expand/contract
 * (docs/runbooks/migrations.md).
 *
 * ONE gate, fed from one of two places. `judge()` is the only implementation.
 * The mode decides only where its inputs come from:
 *
 *   --ci       Diff-only. No database, no network. The pending files are the
 *              migrations this branch adds (git diff against --base). The
 *              database they will meet is unknown, so every object they do not
 *              create themselves is presumed to exist and to be read by N-1.
 *              Editing or deleting an existing migration or snapshot fails.
 *
 *   --target   Pre-deploy, against the real database DATABASE_URL names (the
 *              deploy host's own app env; deploy/ansible/playbooks/update.yml
 *              runs it inside the image about to be deployed). The pending
 *              files are those the runner's ledger has not applied; the
 *              database they will meet is read off its catalog. It also
 *              enforces the mandatory pre-upgrade backup: when anything is
 *              pending, --backup must name a backup taken after the
 *              database's last schema change, and recently.
 *
 * What is judged, in both modes:
 *
 *   1. Order. Every pending file sorts after every file already applied
 *      (target) or already on the base branch (ci): the runner applies by
 *      filename, so an upgraded database would run it last but a fresh one
 *      in the middle.
 *
 *   2. Destructive-DDL lint. Each pending statement, split with the runner's
 *      own splitter (scripts/lib/migration-statements.ts), is parsed with the
 *      real Postgres grammar (libpg_query, compiled to WASM). Judging the parse
 *      tree, not the text, is the point: `DROP` inside a comment, a string
 *      literal, a COMMENT ON or a function body is not a drop, and
 *      `alter table\n x\n drop\n column y` is. A finding may be allowed only by
 *      an annotation in the statement itself:
 *
 *        -- migration-safety: allow column public.users.team_id because <why>
 *
 *      and the annotation is VERIFIED: the snapshot of the release being
 *      replaced must no longer declare the object, so N-1 no longer reads it.
 *
 *   3. Schema contract. Every column the replaced release's snapshot declares
 *      keeps its type and nullability in the newest snapshot (widening only:
 *      varchar(n) → text, NOT NULL → nullable), enums keep their values, and
 *      every NOT NULL column a known table gained has a default, so N-1's
 *      INSERTs, which do not name it, still succeed. An object may be
 *      "forgotten" (absent from the newest snapshot) but not dropped: see
 *      compareSchemas.
 *
 * "The release being replaced" is the newest drizzle snapshot at or before the
 * last settled file: the last file the ledger applied (target), or the last
 * file on the base branch (ci). Snapshots are immutable, so it is read from
 * this tree in both modes.
 *
 * Usage:
 *   bun run migration:safety --ci [--base <rev>]            (default base: merge-base with origin/main)
 *   DATABASE_URL=… bun scripts/check-migration-safety.ts --target --backup '<manifest entry>'
 *       [--backup-max-age-minutes 60]
 *   Either mode takes [--root <repo>].
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SQL } from 'bun'
import {
  loadModule,
  parsePlPgSQLSync,
  parseSync,
  type AlterEnumStmt,
  type AlterObjectSchemaStmt,
  type AlterTableStmt,
  type ColumnDef,
  type Constraint,
  type DeleteStmt,
  type DoStmt,
  type DropStmt,
  type IndexStmt,
  type Node,
  type ObjectType,
  type RangeVar,
  type RenameStmt,
  type TruncateStmt,
} from '@libpg-query/parser'
import {
  LEDGER_TABLE,
  listMigrationFiles,
  migrationChecksum,
  splitMigrationStatements,
} from './lib/migration-statements'

// ── Drizzle snapshots ────────────────────────────────────────────────────────

export interface SnapshotColumn {
  name: string
  type: string
  primaryKey: boolean
  notNull: boolean
  default?: unknown
  identity?: unknown
  generated?: unknown
}

export interface SnapshotTable {
  name: string
  schema: string
  columns: Record<string, SnapshotColumn>
}

export interface SnapshotEnum {
  name: string
  schema: string
  values: string[]
}

export interface SnapshotRelation {
  name: string
  schema: string
  columns?: Record<string, SnapshotColumn>
}

/** The parts of a drizzle-kit (dialect postgresql, version 7) snapshot this gate reads. */
export interface DrizzleSnapshot {
  tables: Record<string, SnapshotTable>
  enums: Record<string, SnapshotEnum>
  views?: Record<string, SnapshotRelation>
  sequences?: Record<string, SnapshotRelation>
  schemas?: Record<string, string>
}

const EMPTY_SNAPSHOT: DrizzleSnapshot = { tables: {}, enums: {} }

/** `0042_foo.sql` and `0042_snapshot.json` → 42. */
function prefixOf(file: string): number | undefined {
  const m = /^(\d+)_/.exec(file)
  return m ? Number(m[1]) : undefined
}

/**
 * The newest `NNNN_snapshot.json` whose number is at most `upTo`'s, or the
 * newest of all when `upTo` is undefined. Hand-written migrations have no
 * snapshot of their own, so the newest one at or before a file is what the
 * schema declared once that file had run.
 */
export function snapshotFileAtOrBefore(metaDir: string, upTo?: string): string | undefined {
  const limit = upTo === undefined ? Number.POSITIVE_INFINITY : (prefixOf(upTo) ?? -1)
  return readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json') && (prefixOf(f) ?? Number.POSITIVE_INFINITY) <= limit)
    .sort()
    .at(-1)
}

/** The snapshot of the release being replaced: the newest at or before the last settled file. */
function previousSnapshotFile(metaDir: string, settled: string[]): string | undefined {
  const last = settled.at(-1)
  return last === undefined ? undefined : snapshotFileAtOrBefore(metaDir, last)
}

function readSnapshot(metaDir: string, file: string | undefined): DrizzleSnapshot {
  return file === undefined ? EMPTY_SNAPSHOT : (JSON.parse(readFileSync(join(metaDir, file), 'utf-8')) as DrizzleSnapshot)
}

// ── The database the pending statements meet ─────────────────────────────────

export interface LiveColumn {
  notNull: boolean
  /**
   * `notNull` is a fact, not a presumption: read off the catalog, or declared
   * by the replaced release's snapshot. `--ci` presumes NOT NULL for a column
   * no snapshot declares, which is the safe guess for the rules that fail on
   * it and the unsafe one for anything that would pass on it.
   */
  provenNotNull: boolean
}

/**
 * What exists in the database before the pending migrations run, which is
 * also what the previous release reads and writes. `--target` reads it off
 * the catalog; `--ci` cannot see a database and presumes it.
 */
export interface LiveSchema {
  relation(schema: string, name: string): boolean
  column(schema: string, table: string, column: string): LiveColumn | undefined
}

/** `--target`: the real catalog of the database about to be migrated. */
export class CatalogSchema implements LiveSchema {
  private readonly relations = new Set<string>()
  private readonly columns = new Map<string, LiveColumn>()

  constructor(
    relations: { schema: string; name: string }[],
    columns: { schema: string; table: string; column: string; not_null: boolean }[],
  ) {
    for (const r of relations) this.relations.add(`${r.schema}.${r.name}`)
    for (const c of columns) this.columns.set(`${c.schema}.${c.table}.${c.column}`, { notNull: c.not_null, provenNotNull: c.not_null })
  }

  static async read(sql: SQL): Promise<CatalogSchema> {
    const userSchemas = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`
    const relations = (await sql.unsafe(
      `SELECT n.nspname AS schema, c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND ${userSchemas}`,
    )) as { schema: string; name: string }[]
    const columns = (await sql.unsafe(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, a.attnotnull AS not_null
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped AND ${userSchemas}`,
    )) as { schema: string; table: string; column: string; not_null: boolean }[]
    return new CatalogSchema(relations, columns)
  }

  relation(schema: string, name: string): boolean {
    return this.relations.has(`${schema}.${name}`)
  }

  column(schema: string, table: string, column: string): LiveColumn | undefined {
    return this.columns.get(`${schema}.${table}.${column}`)
  }
}

/**
 * `--ci`: no database, so presume the worst. Every relation and column exists
 * (N-1 reads it) unless a pending statement creates it. A column's
 * nullability comes from the replaced release's snapshot when it declares the
 * column, and is presumed NOT NULL when it does not.
 */
export class PresumedSchema implements LiveSchema {
  private readonly createdRelations = new Set<string>()
  private readonly createdColumns = new Set<string>()

  constructor(
    statements: string[],
    private readonly previous: SchemaView,
  ) {
    for (const sql of statements) {
      let tree: unknown
      try {
        tree = parseSync(sql)
      } catch {
        continue // judged, and failed, as a parse error by the lint
      }
      this.collect(tree)
    }
  }

  private collect(value: unknown): void {
    if (Array.isArray(value)) return value.forEach((v) => this.collect(v))
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'CreateStmt') {
        const s = child as { relation?: RangeVar; tableElts?: Node[] }
        const t = rel(s.relation)
        if (t) {
          this.createdRelations.add(`${t.schema}.${t.name}`)
          for (const e of s.tableElts ?? []) {
            if ('ColumnDef' in e && e.ColumnDef.colname) this.createdColumns.add(`${t.schema}.${t.name}.${e.ColumnDef.colname}`)
          }
        }
      } else if (key === 'CreateTableAsStmt' || key === 'ViewStmt') {
        const s = child as { into?: { rel?: RangeVar }; view?: RangeVar }
        const t = rel(s.into?.rel ?? s.view)
        if (t) this.createdRelations.add(`${t.schema}.${t.name}`)
      } else if (key === 'CreateSeqStmt') {
        const t = rel((child as { sequence?: RangeVar }).sequence)
        if (t) this.createdRelations.add(`${t.schema}.${t.name}`)
      } else if (key === 'AlterTableStmt') {
        const s = child as AlterTableStmt
        const t = rel(s.relation)
        for (const c of s.cmds ?? []) {
          if (!t || !('AlterTableCmd' in c) || c.AlterTableCmd.subtype !== 'AT_AddColumn') continue
          const def = c.AlterTableCmd.def
          if (def && 'ColumnDef' in def && def.ColumnDef.colname) {
            this.createdColumns.add(`${t.schema}.${t.name}.${def.ColumnDef.colname}`)
          }
        }
      }
      this.collect(child)
    }
  }

  relation(schema: string, name: string): boolean {
    return !this.createdRelations.has(`${schema}.${name}`)
  }

  column(schema: string, table: string, column: string): LiveColumn | undefined {
    if (!this.relation(schema, table) || this.createdColumns.has(`${schema}.${table}.${column}`)) return undefined
    const declared = this.previous.column(schema, table, column)
    return { notNull: declared?.notNull ?? true, provenNotNull: declared?.notNull ?? false }
  }
}

/**
 * The live schema as the pending migrations leave it for N-1, as far as
 * "is this column proven NOT NULL" goes. The gate judges every statement
 * against the schema before the migration, so a `DROP NOT NULL` elsewhere in
 * the pending set would otherwise go unseen: from then on N-1 can write the
 * NULL that a `WHERE col IS NULL` unique index is exempt for never seeing.
 *
 * A `DROP NOT NULL` anywhere in the pending set disqualifies the column,
 * whatever the statement order or file: a migration's statements are no place
 * to infer temporal safety. It removes only `provenNotNull`; `notNull` stays
 * the pre-migration fact the other rules read. A DO block that mentions
 * `DROP NOT NULL` cannot be attributed to a column and disqualifies them all.
 */
export class RelaxedSchema implements LiveSchema {
  private readonly relaxed = new Set<string>()
  private relaxesAny = false

  constructor(
    private readonly inner: LiveSchema,
    statements: string[],
  ) {
    for (const sql of statements) {
      let tree: unknown
      try {
        tree = parseSync(sql)
      } catch {
        continue // judged, and failed, as a parse error by the lint
      }
      this.collect(tree)
    }
  }

  private collect(value: unknown): void {
    if (Array.isArray(value)) return value.forEach((v) => this.collect(v))
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'AlterTableStmt') {
        const s = child as AlterTableStmt
        const t = rel(s.relation)
        for (const c of s.cmds ?? []) {
          if (!('AlterTableCmd' in c) || c.AlterTableCmd.subtype !== 'AT_DropNotNull') continue
          if (t && c.AlterTableCmd.name) this.relaxed.add(`${t.schema}.${t.name}.${c.AlterTableCmd.name}`)
          else this.relaxesAny = true // a form this gate cannot attribute
        }
      } else if (key === 'DoStmt') {
        const body = (child as DoStmt).args?.flatMap((a) => ('DefElem' in a ? [str(a.DefElem.arg) ?? ''] : [])) ?? []
        if (body.some((b) => /drop\s+not\s+null/i.test(b))) this.relaxesAny = true
      }
      this.collect(child)
    }
  }

  relation(schema: string, name: string): boolean {
    return this.inner.relation(schema, name)
  }

  column(schema: string, table: string, column: string): LiveColumn | undefined {
    const live = this.inner.column(schema, table, column)
    if (!live || !(this.relaxesAny || this.relaxed.has(`${schema}.${table}.${column}`))) return live
    return { ...live, provenNotNull: false }
  }
}

const DEFAULT_SCHEMA = 'public'
const RUNBOOK = 'docs/runbooks/migrations.md'

// ── Objects ──────────────────────────────────────────────────────────────────

/** A schema object a finding is about, in the form an annotation names it. */
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

/** Reads one drizzle snapshot the way Postgres resolves names. */
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
  /** The database the statements run against, before any of them runs. */
  live: LiveSchema
  /** The newest snapshot: what the release being deployed declares. */
  next: SchemaView
}

export function lintContext(live: LiveSchema, next: DrizzleSnapshot): LintContext {
  return { live, next: new SchemaView(next) }
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

function lintAlterTable(stmt: AlterTableStmt, ctx: LintContext, out: Finding[]): void {
  if (stmt.objtype !== 'OBJECT_TABLE' && stmt.objtype !== 'OBJECT_FOREIGN_TABLE') return
  const table = rel(stmt.relation)
  if (!table) return
  const column = (c: string): ObjectRef => ({ kind: 'column', schema: table.schema, table: table.name, column: c })
  const tableExists = ctx.live.relation(table.schema, table.name)
  const liveColumn = (c: string) => ctx.live.column(table.schema, table.name, c)

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
        const was = liveColumn(name)
        const now = ctx.next.column(table.schema, table.name, name)
        if (was && (was.notNull || now?.notNull)) {
          out.push({ rule: 'drop-default-not-null', object: column(name) })
        }
        break
      }
      case 'AT_AddColumn': {
        const def = cmd.def && 'ColumnDef' in cmd.def ? cmd.def.ColumnDef : undefined
        if (def?.colname && tableExists && addsNotNullWithoutDefault(def)) {
          out.push({ rule: 'add-not-null-column-without-default', object: column(def.colname) })
        }
        break
      }
      case 'AT_AddConstraint': {
        const con = cmd.def && 'Constraint' in cmd.def ? cmd.def.Constraint : undefined
        if (!con || !tableExists) break
        const hit = existingConstraintColumn(con, liveColumn)
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
 * told (USING INDEX, EXCLUDE); `null` when it binds only columns the database
 * does not have yet (N-1 leaves those NULL, which UNIQUE, FK and CHECK all
 * accept), or the constraint type cannot reject a write.
 */
function existingConstraintColumn(
  con: Constraint,
  liveColumn: (c: string) => LiveColumn | undefined,
): string | undefined | null {
  const firstExisting = (cols: string[]) => cols.find((c) => liveColumn(c) !== undefined) ?? null
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

/**
 * Does a partial index's predicate provably match no row the table holds now?
 * Only the one shape that can be proved from the schema alone: `col IS NULL`
 * on a column that is NOT NULL before this migration runs. No existing row has
 * NULL there, and N-1 cannot write one (it could not before), so the index has
 * nothing to reject. A top-level AND is empty when any one conjunct is (drizzle
 * writes `closed_at IS NULL AND hub_id IS NULL`); OR, NOT and every other
 * predicate may match rows, and are judged as if there were none.
 */
function matchesNoExistingRow(
  where: Node | undefined,
  table: { schema: string; name: string },
  live: LiveSchema,
): boolean {
  if (!where) return false
  if ('BoolExpr' in where) {
    return where.BoolExpr.boolop === 'AND_EXPR' && (where.BoolExpr.args ?? []).some((a) => matchesNoExistingRow(a, table, live))
  }
  if (!('NullTest' in where) || where.NullTest.nulltesttype !== 'IS_NULL') return false
  const arg = where.NullTest.arg
  if (!arg || !('ColumnRef' in arg)) return false
  const fields = arg.ColumnRef.fields ?? []
  const column = str(fields.at(-1))
  if (column === undefined) return false
  // `t.col` or `schema.t.col` must name this table; a bare `col` cannot name another.
  if (fields.length > 1 && str(fields.at(-2)) !== table.name) return false
  return live.column(table.schema, table.name, column)?.provenNotNull === true
}

function lintNode(key: string, value: unknown, ctx: LintContext, out: Finding[]): void {
  switch (key) {
    case 'AlterTableStmt':
      lintAlterTable(value as AlterTableStmt, ctx, out)
      return
    case 'DropStmt': {
      const s = value as DropStmt
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
      const s = value as RenameStmt
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
      const s = value as AlterEnumStmt
      const t = qualifiedName((s.typeName ?? []).map(str))
      if (t && s.oldVal) {
        out.push({ rule: 'rename', object: { kind: 'enum-value', schema: t.schema, type: t.name, value: s.oldVal } })
      }
      return
    }
    case 'AlterObjectSchemaStmt': {
      const s = value as AlterObjectSchemaStmt
      const target = rel(s.relation) ?? qualifiedName(listNames(s.object))
      const ref = target && relationKindRef(s.objectType, target)
      if (ref) out.push({ rule: 'set-schema', object: ref })
      return
    }
    case 'IndexStmt': {
      const s = value as IndexStmt
      const t = rel(s.relation)
      if (!s.unique || !t || !ctx.live.relation(t.schema, t.name)) return
      const cols = (s.indexParams ?? []).flatMap((p) =>
        'IndexElem' in p ? (p.IndexElem.name ? [p.IndexElem.name] : columnRefs(p.IndexElem.expr)) : [],
      )
      const hit = cols.find((c) => ctx.live.column(t.schema, t.name, c) !== undefined)
      if (hit && !matchesNoExistingRow(s.whereClause, t, ctx.live)) {
        out.push({ rule: 'unique-index-existing', object: { kind: 'column', schema: t.schema, table: t.name, column: hit } })
      }
      return
    }
    case 'TruncateStmt': {
      const s = value as TruncateStmt
      for (const r of s.relations ?? []) {
        const t = 'RangeVar' in r ? rel(r.RangeVar) : undefined
        if (t) out.push({ rule: 'truncate', object: { kind: 'relation', ...t } })
      }
      return
    }
    case 'DeleteStmt': {
      const s = value as DeleteStmt
      const t = rel(s.relation)
      if (t && !s.whereClause) out.push({ rule: 'delete-without-where', object: { kind: 'relation', ...t } })
      return
    }
    case 'DoStmt':
      lintDoBlock(value as DoStmt, ctx, out)
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
function lintDoBlock(stmt: DoStmt, ctx: LintContext, out: Finding[]): void {
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


// ── Annotations ──────────────────────────────────────────────────────────────

/**
 * `-- migration-safety: allow <object> because <reason>`, where `<object>` is
 * a finding's object exactly as the gate prints it (`column public.users.team_id`).
 * It allows findings on that object in the statement (the chunk between
 * breakpoints) that carries it, and nowhere else.
 */
const ANNOTATION_MARK = /^\s*--\s*migration-safety:/
const ANNOTATION = /^\s*--\s*migration-safety:\s*allow\s+(\S+\s+\S+)\s+because\s+(\S.*)$/

export interface Annotation {
  object: string
  reason: string
}

/** The annotations in one statement, and the lines that look like one but do not parse. */
export function parseAnnotations(statement: string): { annotations: Annotation[]; malformed: string[] } {
  const annotations: Annotation[] = []
  const malformed: string[] = []
  for (const line of statement.split('\n')) {
    if (!ANNOTATION_MARK.test(line)) continue
    const m = ANNOTATION.exec(line)
    if (m) annotations.push({ object: m[1], reason: m[2].trim() })
    else malformed.push(line.trim())
  }
  return { annotations, malformed }
}

// ── The gate ─────────────────────────────────────────────────────────────────

export interface Violation {
  file?: string
  statementIndex?: number
  message: string
}

/** Everything `judge()` needs; the two modes differ only in how they fill it. */
export interface GateInput {
  /** The repo whose drizzle/migrations/ holds the files. */
  root: string
  /** Files already applied (target) or already on the base branch (ci), in order. */
  settled: string[]
  /** Files this deploy or branch adds, in order. Each is judged. */
  pending: string[]
  /** The database `pending` runs against. */
  live: LiveSchema
  /** Problems the source found before judging (ledger, immutability, backup). */
  preflight: Violation[]
}

export interface SafetyReport {
  /** The snapshot of the release being replaced, or undefined when none exists. */
  previousSnapshot: string | undefined
  judgedFiles: string[]
  allowed: number
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
 * Part 3: the newest snapshot against the replaced release's.
 *
 * An object the replaced release declares may be absent from the newest
 * snapshot: that is "forgetting" it, the step before contracting it. The code
 * stops declaring it while the database keeps it, so the previous release
 * still finds it; part 2 rejects every pending statement that would physically
 * drop or rename it. Without this, an object that ever shipped could never be
 * dropped: the annotation for its DROP is verified against a snapshot that
 * must no longer declare it.
 *
 * What may not happen to an object the replaced release declares and the
 * newest snapshot still has: a type change other than a listed widening, a
 * nullable column becoming NOT NULL, an enum losing a value.
 */
export function compareSchemas(previous: DrizzleSnapshot, next: DrizzleSnapshot): string[] {
  const problems: string[] = []
  for (const [key, table] of Object.entries(previous.tables)) {
    const cur = next.tables[key]
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
        `column ${key}.${name} is NOT NULL with no default on a table the previous release declares; ` +
          "its INSERTs do not name it",
      )
    }
  }
  for (const [key, e] of Object.entries(previous.enums)) {
    const cur = next.enums[key]
    if (!cur) continue
    for (const v of e.values) {
      if (!cur.values.includes(v)) problems.push(`enum ${key} lost value '${v}'`)
    }
  }
  return problems
}

/** The one gate. Both modes end here; see the file header. */
export async function judge(input: GateInput): Promise<SafetyReport> {
  await loadModule()
  const migrationsDir = join(input.root, 'drizzle', 'migrations')
  const metaDir = join(migrationsDir, 'meta')
  const violations: Violation[] = [...input.preflight]

  // ── 1. Order ───────────────────────────────────────────────────────────────
  const lastSettled = input.settled.at(-1)
  for (const f of input.pending) {
    if (lastSettled !== undefined && f < lastSettled) {
      violations.push({
        file: f,
        message:
          `${f} sorts before ${lastSettled}, which already ran. An upgraded database would apply ` +
          'it last but a fresh one in the middle; name it after the newest existing file.',
      })
    }
  }

  const previousSnapshot = previousSnapshotFile(metaDir, input.settled)
  const previous = new SchemaView(readSnapshot(metaDir, previousSnapshot))
  const next = readSnapshot(metaDir, snapshotFileAtOrBefore(metaDir))
  const pendingStatements = input.pending.flatMap((f) => splitMigrationStatements(readFileSync(join(migrationsDir, f), 'utf-8')))
  const ctx = lintContext(new RelaxedSchema(input.live, pendingStatements), next)

  // ── 2. Destructive-DDL lint, with verified annotations ─────────────────────
  let allowed = 0
  for (const file of input.pending) {
    const statements = splitMigrationStatements(readFileSync(join(migrationsDir, file), 'utf-8'))
    statements.forEach((sql, statementIndex) => {
      const findings: Located[] = lintSql(sql, ctx).map((f) => ({ ...f, file, statementIndex }))
      const { annotations, malformed } = parseAnnotations(sql)
      const at = `${file} statement ${statementIndex}`
      for (const line of malformed) {
        violations.push({
          file,
          statementIndex,
          message: `${at}: unreadable annotation \`${line}\`. The form is \`-- migration-safety: allow <object> because <reason>\`.`,
        })
      }
      const allowedHere = new Set<Located>()
      for (const a of annotations) {
        const matches = findings.filter((f) => f.object && describeObject(f.object) === a.object)
        if (matches.length === 0) {
          violations.push({
            file,
            statementIndex,
            message: `${at}: the annotation for ${a.object} matches no finding in this statement. Remove it.`,
          })
          continue
        }
        if (previous.declares(matches[0].object as ObjectRef)) {
          violations.push({
            file,
            statementIndex,
            message:
              `${at}: the annotation for ${a.object} is rejected: the release being replaced ` +
              `(${previousSnapshot}) still declares it, so it still reads it. Stop declaring it in one ` +
              'release and contract it in a later one.',
          })
          continue
        }
        for (const m of matches) allowedHere.add(m)
      }
      allowed += allowedHere.size
      for (const f of findings) {
        if (!allowedHere.has(f)) violations.push({ file, statementIndex, message: findingMessage(f) })
      }
    })
  }

  // ── 3. Schema contract ─────────────────────────────────────────────────────
  if (input.pending.length > 0) {
    for (const message of compareSchemas(previous.snapshot, next)) {
      violations.push({ message: `schema contract vs ${previousSnapshot ?? 'an empty schema'}: ${message}` })
    }
  }

  return { previousSnapshot, judgedFiles: input.pending, allowed, violations }
}

// ── --ci: the branch's diff ──────────────────────────────────────────────────

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString()
}

/** A shipped file the runner or drizzle-kit treats as immutable. */
const IMMUTABLE = /^drizzle\/migrations\/(?:[^/]+\.sql|meta\/\d+_snapshot\.json)$/

/**
 * The migrations the working tree adds relative to `base`, and every edit or
 * deletion of a file that already existed there. Untracked files count as
 * added, so a migration not yet committed is judged too.
 */
export async function ciInput(root: string, base: string): Promise<GateInput> {
  await loadModule()
  const migrationsDir = join(root, 'drizzle', 'migrations')
  const preflight: Violation[] = []
  const added = new Set<string>()
  const diff = git(root, 'diff', '--name-status', '--no-renames', base, '--', 'drizzle/migrations')
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '--', 'drizzle/migrations')
  const entries = [
    ...diff.split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]),
    ...untracked.split('\n').filter(Boolean).map((p) => ['A', p] as [string, string]),
  ]
  for (const [status, path] of entries) {
    if (!IMMUTABLE.test(path)) continue
    if (status === 'A') {
      if (path.endsWith('.sql')) added.add(path.slice('drizzle/migrations/'.length))
      continue
    }
    preflight.push({
      message:
        `${path} existed at ${base} and is ${status === 'D' ? 'deleted' : 'edited'} here. A migration ` +
        'or snapshot that may have shipped is immutable: the runner refuses a file whose checksum ' +
        'changed. Add a new migration instead.',
    })
  }
  const files = listMigrationFiles(migrationsDir)
  const settled = files.filter((f) => !added.has(f))
  const pending = files.filter((f) => added.has(f))
  const metaDir = join(migrationsDir, 'meta')
  const previous = new SchemaView(readSnapshot(metaDir, previousSnapshotFile(metaDir, settled)))
  const statements = pending.flatMap((f) => splitMigrationStatements(readFileSync(join(migrationsDir, f), 'utf-8')))
  return { root, settled, pending, live: new PresumedSchema(statements, previous), preflight }
}

// ── --target: the database about to be migrated ──────────────────────────────

/**
 * One line of the backup manifest `backup-postgres.sh` appends
 * (deploy/ansible/roles/backup-postgres/templates/backup-postgres.sh.j2):
 * `postgres|<YYYYMMDD-HHMMSS UTC>|<file>|<bytes>|<sha256 of the dump>|<type>`.
 */
const MANIFEST_ENTRY = /^postgres\|(\d{8})-(\d{6})\|(llamenos-postgres-\S+\.dump\.age)\|(\d+)\|([0-9a-f]{64})\|(\w+)$/

export interface BackupProof {
  takenAt: Date
  file: string
  bytes: number
}

export function parseBackupEntry(entry: string): BackupProof | string {
  const m = MANIFEST_ENTRY.exec(entry.trim())
  if (!m) return `--backup is not a backup-postgres.sh manifest entry: "${entry.trim()}"`
  const [, d, t, file, bytes] = m
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`
  const takenAt = new Date(iso)
  if (Number.isNaN(takenAt.getTime())) return `--backup has an impossible timestamp: ${d}-${t}`
  if (Number(bytes) === 0) return `--backup names an empty file: ${file}`
  return { takenAt, file, bytes: Number(bytes) }
}

export interface TargetOptions {
  root: string
  databaseUrl: string
  /** The manifest entry of the pre-upgrade backup, or undefined when none was given. */
  backup: string | undefined
  backupMaxAgeMinutes: number
}

/** A backup clock may run slightly ahead of the database's. */
const CLOCK_SKEW_MS = 5 * 60_000

/**
 * The mandatory pre-upgrade backup (operator decision C1): before a deploy
 * migrates a database, a backup must exist that was taken after the
 * database's last schema change, so it holds the schema being replaced, and
 * within --backup-max-age-minutes of now by the database's clock. Returns
 * what is wrong, or undefined.
 */
function checkBackup(opts: TargetOptions, now: Date, lastChange: Date | undefined): string | undefined {
  const proof = opts.backup === undefined ? 'no --backup was given' : parseBackupEntry(opts.backup)
  if (typeof proof === 'string') return `${proof}. Migrating a database without one is refused (${RUNBOOK}).`
  if (lastChange !== undefined && proof.takenAt.getTime() < lastChange.getTime()) {
    return (
      `${proof.file} was taken at ${proof.takenAt.toISOString()}, before this database's last schema ` +
      `change at ${lastChange.toISOString()}. It cannot restore the schema being replaced.`
    )
  }
  const ageMs = now.getTime() - proof.takenAt.getTime()
  if (ageMs > opts.backupMaxAgeMinutes * 60_000 || ageMs < -CLOCK_SKEW_MS) {
    return (
      `${proof.file} was taken at ${proof.takenAt.toISOString()} and the database clock reads ` +
      `${now.toISOString()}; it must be from the last ${opts.backupMaxAgeMinutes} minutes.`
    )
  }
  console.log(`[migration-safety] pre-upgrade backup ${proof.file} (${proof.bytes} bytes, ${proof.takenAt.toISOString()})`)
  return undefined
}

/**
 * Reads the ledger and the catalog of the database about to be migrated. The
 * files the ledger has not applied are pending; the catalog is what they meet.
 * A database with neither ledger nor schema is fresh: no previous release runs
 * against it and there is nothing to back up, so nothing is pending judgement.
 */
export async function targetInput(opts: TargetOptions): Promise<GateInput> {
  const migrationsDir = join(opts.root, 'drizzle', 'migrations')
  const files = listMigrationFiles(migrationsDir)
  const sql = new SQL({ url: opts.databaseUrl, max: 1, connectionTimeout: 30 })
  try {
    const [{ ledger, schema, now }] = (await sql.unsafe(
      `SELECT to_regclass('public.${LEDGER_TABLE}') IS NOT NULL AS ledger,
              to_regclass('public.users') IS NOT NULL AS schema,
              now() AS now`,
    )) as { ledger: boolean; schema: boolean; now: Date }[]
    const live = await CatalogSchema.read(sql)
    if (!ledger && !schema) {
      console.log('[migration-safety] fresh database: no previous release runs against it, nothing to judge')
      return { root: opts.root, settled: files, pending: [], live, preflight: [] }
    }
    const preflight: Violation[] = []
    if (!ledger) {
      return {
        root: opts.root,
        settled: files,
        pending: [],
        live,
        preflight: [
          {
            message:
              `the database has a schema but no ${LEDGER_TABLE}, so which files are pending cannot be ` +
              'told. It predates the ledger; see the CATCH-UP RUN notes in scripts/run-migrations.ts.',
          },
        ],
      }
    }

    const rows = (await sql.unsafe(`SELECT filename, checksum, applied_at FROM ${LEDGER_TABLE}`)) as {
      filename: string
      checksum: string | null
      applied_at: Date | null
    }[]
    const present = new Set(files)
    const applied = new Set<string>()
    let lastChange: Date | undefined
    for (const r of rows) {
      if (r.applied_at === null) {
        preflight.push({
          file: r.filename,
          message: `${r.filename} is reserved for an unfinished catch-up run. Finish it with the release that started it.`,
        })
        continue
      }
      applied.add(r.filename)
      if (lastChange === undefined || r.applied_at > lastChange) lastChange = r.applied_at
      if (!present.has(r.filename)) {
        preflight.push({
          file: r.filename,
          message: `${r.filename} is applied to this database but absent from this release. Shipped migrations are never deleted.`,
        })
        continue
      }
      const checksum = migrationChecksum(readFileSync(join(migrationsDir, r.filename), 'utf-8'))
      if (r.checksum !== checksum) {
        preflight.push({
          file: r.filename,
          message: `${r.filename} was applied with checksum ${r.checksum} but this release's copy hashes to ${checksum}. The runner will refuse to start.`,
        })
      }
    }

    const pending = files.filter((f) => !applied.has(f))
    const backupProblem = pending.length === 0 ? undefined : checkBackup(opts, now, lastChange)
    if (pending.length === 0) {
      console.log('[migration-safety] nothing pending: this deploy does not change the schema, so no backup is required')
    } else if (backupProblem !== undefined) {
      preflight.push({ message: `pre-upgrade backup: ${backupProblem}` })
    }

    return { root: opts.root, settled: files.filter((f) => applied.has(f)), pending, live, preflight }
  } finally {
    await sql.close()
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i === -1) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} needs a value`)
    process.exit(2)
  }
  return v
}

if (import.meta.main) {
  const ci = process.argv.includes('--ci')
  const target = process.argv.includes('--target')
  if (ci === target) {
    console.error('usage: check-migration-safety.ts --ci [--base <rev>] | --target --backup <manifest entry>   [--root <repo>]')
    process.exit(2)
  }
  const root = arg('--root') ?? join(import.meta.dir, '..')

  let input: GateInput
  if (ci) {
    const base = arg('--base') ?? git(root, 'merge-base', 'origin/main', 'HEAD').trim()
    input = await ciInput(root, base)
    console.log(`[migration-safety] --ci: judging the migrations added since ${base}`)
  } else {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
      console.error('--target needs DATABASE_URL: the database this deploy is about to migrate')
      process.exit(2)
    }
    const maxAge = Number(arg('--backup-max-age-minutes') ?? '60')
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      console.error('--backup-max-age-minutes must be a positive number')
      process.exit(2)
    }
    input = await targetInput({ root, databaseUrl, backup: arg('--backup'), backupMaxAgeMinutes: maxAge })
    console.log('[migration-safety] --target: judging the migrations this database has not applied')
  }

  const report = await judge(input)
  console.log(
    `[migration-safety] judged ${report.judgedFiles.length} pending migration file(s) against ` +
      `${report.previousSnapshot ?? 'no previous snapshot'}` +
      `${report.judgedFiles.length ? `: ${report.judgedFiles.join(', ')}` : ''}` +
      (report.allowed ? `; ${report.allowed} finding(s) allowed by verified annotations` : ''),
  )
  for (const v of report.violations) {
    if (ci && process.env.GITHUB_ACTIONS === 'true') {
      const file = v.file ? ` file=drizzle/migrations/${v.file}` : ''
      console.log(`::error${file}::${v.message}`)
    } else {
      console.error(`  ✗ ${v.message}`)
    }
  }
  if (report.violations.length > 0) {
    console.error(`[migration-safety] FAILED: ${report.violations.length} violation(s)`)
    process.exit(1)
  }
  console.log('[migration-safety] OK')
}
