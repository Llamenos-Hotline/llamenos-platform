/**
 * Rails for scripts/lib/migration-graph.ts: the snapshot DAG every migration
 * gate reads (#2391).
 *
 *   bun test scripts/lib/migration-graph.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { MigrationGraph, merge3, type SnapshotJson } from './migration-graph'

const META = join(import.meta.dir, '..', '..', 'drizzle', 'migrations', 'meta')

const col = (type: string) => ({ name: 'c', type, notNull: false, primaryKey: false })
function snap(id: string, tables: Record<string, Record<string, unknown>>, prevIds?: string[]): SnapshotJson {
  return { id, prevId: prevIds?.[0], ...(prevIds ? { prevIds } : {}), tables, enums: {} }
}

describe('merge3', () => {
  const conflicts = (base: unknown, a: unknown, b: unknown) => {
    const out: string[] = []
    const merged = merge3(base, a, b, [], (p) => out.push(p.join('.')))
    return { merged, out }
  }

  test('each side keeps what it changed', () => {
    expect(conflicts({ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 3 })).toEqual({ merged: { x: 2, y: 3 }, out: [] })
  })

  test('an addition on each side is both additions', () => {
    expect(conflicts({ t: {} }, { t: { a: 1 } }, { t: { b: 2 } })).toEqual({ merged: { t: { a: 1, b: 2 } }, out: [] })
  })

  test('a deletion on one side survives an untouched other side', () => {
    expect(conflicts({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 })).toEqual({ merged: { a: 1 }, out: [] })
  })

  test('agreement is not a conflict', () => {
    expect(conflicts({ a: 1 }, { a: 5 }, { a: 5 }).out).toEqual([])
  })

  test('the same leaf changed differently conflicts, at its path', () => {
    expect(conflicts({ t: { c: 'text' } }, { t: { c: 'int' } }, { t: { c: 'uuid' } }).out).toEqual(['t.c'])
  })

  test('deleted on one side, edited on the other, conflicts', () => {
    expect(conflicts({ t: { c: 1 } }, { t: {} }, { t: { c: 2 } }).out).toEqual(['t.c'])
  })

  test('the same key created differently on both sides conflicts as a whole', () => {
    // Two CREATE TABLE foo: the second is a no-op where the first already ran.
    expect(conflicts({}, { foo: { a: 1 } }, { foo: { b: 1 } }).out).toEqual(['foo'])
  })

  test('arrays are leaves: two appended enum values conflict (their order would differ)', () => {
    expect(conflicts({ v: ['a'] }, { v: ['a', 'b'] }, { v: ['a', 'c'] }).out).toEqual(['v'])
  })
})

describe('MigrationGraph', () => {
  const root = snap('root', { 'public.users': { columns: { id: col('text') } } })

  test("this repo's legacy snapshots read as one line ending at the newest", () => {
    const g = MigrationGraph.load(META)
    expect(g.problems).toEqual([])
    expect(g.heads().map((h) => h.file)).toEqual([g.nodes.at(-1)?.file as string])
    // 0032 and 0043 record prevIds that no snapshot has; read as a line, they are fine.
    expect(g.nodes.every((n, i) => i === 0 || n.parents[0] === g.nodes[i - 1].file)).toBe(true)
  })

  test('two branches off one parent are two concurrent heads, merged', () => {
    const g = MigrationGraph.fromSnapshots([
      { file: '0001_snapshot.json', snapshot: root },
      { file: '20261030110000_snapshot.json', snapshot: snap('a', { 'public.users': { columns: { id: col('text'), a: col('text') } } }, ['root']) },
      { file: '20261030120000_snapshot.json', snapshot: snap('b', { 'public.users': { columns: { id: col('text') } }, 'public.b': { columns: {} } }, ['root']) },
    ])
    expect(g.problems).toEqual([])
    expect(g.concurrent('20261030110000_snapshot.json', '20261030120000_snapshot.json')).toBe(true)
    const { heads, schema, conflicts } = g.state()
    expect(heads.map((h) => h.file)).toEqual(['20261030110000_snapshot.json', '20261030120000_snapshot.json'])
    expect(conflicts).toEqual([])
    expect(Object.keys((schema.tables as Record<string, { columns: object }>)['public.users'].columns)).toEqual(['id', 'a'])
    expect(Object.keys(schema.tables as object).sort()).toEqual(['public.b', 'public.users'])
  })

  test('a snapshot naming both heads joins them; it is no longer concurrent with either', () => {
    const g = MigrationGraph.fromSnapshots([
      { file: '0001_snapshot.json', snapshot: root },
      { file: '20261030110000_snapshot.json', snapshot: snap('a', {}, ['root']) },
      { file: '20261030120000_snapshot.json', snapshot: snap('b', {}, ['root']) },
      { file: '20261030130000_snapshot.json', snapshot: snap('c', {}, ['a', 'b']) },
    ])
    expect(g.heads().map((h) => h.file)).toEqual(['20261030130000_snapshot.json'])
    expect(g.concurrent('20261030110000_snapshot.json', '20261030130000_snapshot.json')).toBe(false)
  })

  test('the state of a subset is what those files built', () => {
    const g = MigrationGraph.fromSnapshots([
      { file: '0001_snapshot.json', snapshot: root },
      { file: '20261030110000_snapshot.json', snapshot: snap('a', { a: {} }, ['root']) },
      { file: '20261030120000_snapshot.json', snapshot: snap('b', { b: {} }, ['root']) },
    ])
    const built = g.builtBy(['0001_x.sql', '20261030120000_b.sql'])
    expect([...built].sort()).toEqual(['0001_snapshot.json', '20261030120000_snapshot.json'])
    expect(Object.keys(g.state(built).schema.tables as object)).toEqual(['b'])
  })

  test('a legacy hand-written file belongs to the newest legacy snapshot before it', () => {
    const g = MigrationGraph.fromSnapshots([
      { file: '0001_snapshot.json', snapshot: snap('one', {}) },
      { file: '0004_snapshot.json', snapshot: snap('four', {}) },
    ])
    expect(g.nodeForMigration('0003_hand_written.sql')?.file).toBe('0001_snapshot.json')
    expect(g.nodeForMigration('20261030110000_no_snapshot.sql')).toBeUndefined()
  })

  test('BREAK IT: structural problems are reported, each naming the file', () => {
    const g = MigrationGraph.fromSnapshots([
      { file: '0001_snapshot.json', snapshot: snap('root', {}) },
      { file: '0002_snapshot.json', snapshot: snap('root', {}) },
      { file: '20261030110000_snapshot.json', snapshot: snap('a', {}, ['nowhere']) },
      { file: '20261030120000_snapshot.json', snapshot: snap('b', {}) },
      { file: '20261030090000_snapshot.json', snapshot: snap('early', {}, ['c']) },
      { file: '20261030130000_snapshot.json', snapshot: snap('c', {}, ['root']) },
      { file: '12345_snapshot.json', snapshot: snap('odd', {}, ['root']) },
    ])
    const text = g.problems.join('\n')
    expect(text).toContain('0002_snapshot.json repeats the id root')
    expect(text).toContain('20261030110000_snapshot.json names parent nowhere')
    expect(text).toContain('20261030120000_snapshot.json has no prevIds')
    expect(text).toContain('20261030090000_snapshot.json sorts before its own parent 20261030130000_snapshot.json')
    expect(text).toContain('12345_snapshot.json: snapshots are named NNNN_')
  })

  test('BREAK IT: heads that changed the same column differently report the conflict', () => {
    const g = MigrationGraph.fromSnapshots([
      { file: '0001_snapshot.json', snapshot: root },
      { file: '20261030110000_snapshot.json', snapshot: snap('a', { 'public.users': { columns: { id: col('uuid') } } }, ['root']) },
      { file: '20261030120000_snapshot.json', snapshot: snap('b', { 'public.users': { columns: { id: col('integer') } } }, ['root']) },
    ])
    const { conflicts } = g.state()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toContain('tables.public.users.columns.id.type was changed differently by 20261030120000_snapshot.json')
    expect(conflicts[0]).toContain('common ancestor 0001_snapshot.json')
  })
})
