/**
 * Hub isolation is a property of the declaration, not of reviewer attention.
 *
 * A user belongs to many hubs and their PUK is shared across all of them, so a
 * shred of hub A that reaches a user-scoped table locks that user out of hub B.
 * These tests make that unrepresentable: every target must be confined to one
 * hub, no target may name a table that is not hub-scoped, and every table and
 * column named must actually exist — a typo'd column silently shreds nothing.
 */
import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  HUB_SHRED_TARGETS,
  CROSS_HUB_TABLES,
  type HubShredTarget,
} from '../../services/hub-shred-targets'
import * as schema from '../../db/schema'

type Scoped = Exclude<HubShredTarget, { kind: 'audit-shred' }>
const scoped = HUB_SHRED_TARGETS.filter((t): t is Scoped => t.kind !== 'audit-shred')
const namedTables = scoped.map(t => t.table)

/** table name → its column names, read from the live drizzle schema. */
const columnsByTable = new Map<string, Set<string>>()
for (const value of Object.values(schema)) {
  try {
    const config = getTableConfig(value as never)
    columnsByTable.set(config.name, new Set(config.columns.map(c => c.name)))
  } catch {
    // not a pg table export
  }
}

describe('HUB_SHRED_TARGETS', () => {
  it('confines every target to a single hub', () => {
    for (const target of scoped) {
      expect(['hub-id', 'parent'], `${target.table} has an unrecognised scope`)
        .toContain(target.scope.via)
      if (target.scope.via === 'parent') {
        expect(target.scope.parentTable, `${target.table} has no parent table`).toBeTruthy()
        expect(target.scope.fk, `${target.table} has no foreign key`).toBeTruthy()
      }
    }
  })

  it('names no cross-hub table', () => {
    for (const forbidden of CROSS_HUB_TABLES) {
      expect(
        namedTables,
        `${forbidden} is user- or platform-scoped: shredding it for one hub would ` +
        `revoke the same user's access to every other hub they belong to`,
      ).not.toContain(forbidden)
    }
  })

  it('lists every cross-hub table the spec forbids', () => {
    // Spec §4 "What shred must NOT touch". Adding a table here is cheap;
    // forgetting one is how a volunteer in two hubs loses both.
    expect([...CROSS_HUB_TABLES].sort()).toEqual([
      'audit_user_keys', 'devices', 'entity_type_templates',
      'platform_role_envelopes', 'provision_rooms', 'puk_envelopes',
      'roles', 'sessions', 'sigchain_links', 'user_role_envelopes',
      'user_signal_contacts', 'users', 'webauthn_credentials',
    ])
  })

  it('declares exactly one audit-shred step', () => {
    expect(HUB_SHRED_TARGETS.filter(t => t.kind === 'audit-shred')).toHaveLength(1)
  })

  it('names each table at most once', () => {
    expect(
      new Set(namedTables).size,
      'a table declared twice is a target that will be edited in one place only',
    ).toBe(namedTables.length)
  })

  it('clears at least one column on every clear-envelopes target', () => {
    for (const target of scoped) {
      if (target.kind !== 'clear-envelopes') continue
      expect(Object.keys(target.columns).length, `${target.table} clears nothing`)
        .toBeGreaterThan(0)
      for (const [column, value] of Object.entries(target.columns)) {
        expect(
          ["'[]'::jsonb", 'NULL'],
          `${target.table}.${column} uses a value the executor will not accept`,
        ).toContain(value)
      }
    }
  })

  it('covers every class in spec §4', () => {
    const named = new Set(namedTables)
    for (const required of [
      // A — the hub key's own wraps
      'hub_keys',
      // B — per-row recipient envelopes
      'notes', 'note_replies', 'call_records', 'messages', 'files',
      'contact_identifiers', 'case_records', 'case_interactions', 'evidence',
      'report_cases', 'events', 'contacts', 'contact_relationships', 'affinity_groups',
      // C — server-sealed hub rows
      'hub_storage_credentials', 'provider_configs', 'signal_registrations',
      'a2p_registrations', 'firehose_connections', 'firehose_window_keys',
      'firehose_message_buffer', 'subscribers',
      // D — key-recovery paths
      'hub_recovery_groups', 'hub_recovery_group_shares', 'user_recovery_envelopes',
      'recovery_sessions', 'recovery_session_contributions', 'mls_pending_messages',
      // F — hub bearer tokens
      'call_tokens', 'invite_codes',
    ]) {
      expect(named, `${required} is in the spec's shred set but not in HUB_SHRED_TARGETS`)
        .toContain(required)
    }
  })

  it('names only real tables, real columns and real hub predicates', () => {
    for (const target of scoped) {
      const columns = columnsByTable.get(target.table)
      expect(columns, `no such table: ${target.table}`).toBeDefined()

      if (target.scope.via === 'parent') {
        expect(columns!, `${target.table}.${target.scope.fk} does not exist`)
          .toContain(target.scope.fk)
        const parent = columnsByTable.get(target.scope.parentTable)
        expect(parent, `no such parent table: ${target.scope.parentTable}`).toBeDefined()
        expect(parent!, `${target.scope.parentTable} has no hub_id to scope by`)
          .toContain('hub_id')
        expect(parent!, `${target.scope.parentTable}.${target.scope.parentKey ?? 'id'} does not exist`)
          .toContain(target.scope.parentKey ?? 'id')
      } else {
        expect(columns!, `${target.table} has no ${target.scope.column ?? 'hub_id'} column`)
          .toContain(target.scope.column ?? 'hub_id')
      }

      if (target.kind === 'clear-envelopes') {
        for (const column of Object.keys(target.columns)) {
          expect(columns!, `${target.table}.${column} does not exist`).toContain(column)
        }
      }
    }
  })

  it('deletes children before their parents', () => {
    const deleteOrder = scoped
      .filter(t => t.kind === 'delete-rows')
      .map(t => t.table)
    for (const target of scoped) {
      if (target.kind !== 'delete-rows' || target.scope.via !== 'parent') continue
      const childAt = deleteOrder.indexOf(target.table)
      const parentAt = deleteOrder.indexOf(target.scope.parentTable)
      if (parentAt === -1) continue
      expect(
        childAt,
        `${target.table} is deleted after its parent ${target.scope.parentTable}, ` +
        'so its hub predicate resolves against rows that are already gone',
      ).toBeLessThan(parentAt)
    }
  })
})
