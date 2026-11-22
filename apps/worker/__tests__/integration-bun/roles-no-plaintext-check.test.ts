/**
 * The database refuses a custom role that carries plaintext vocabulary (#2787).
 *
 * `roles_custom_role_has_no_plaintext`: a role that is not `is_default` has
 * `name` NULL, `description` '' and `slug` = `id`. SettingsService has never
 * written otherwise since #2780; this pins that the schema now refuses it too.
 *
 *   bun test apps/worker/__tests__/integration-bun/roles-no-plaintext-check.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { roles } from '../../db/schema'

const db = createDatabase(process.env.DATABASE_URL!)
const suite = crypto.randomUUID().slice(0, 8)
const created: string[] = []

async function insert(values: Partial<typeof roles.$inferInsert> & { id: string }) {
  created.push(values.id)
  await db.insert(roles).values({ slug: values.id, permissions: ['notes:read-own'], ...values })
}

/** The Postgres error is wrapped by drizzle; the constraint name rides on the cause chain. */
async function refusedByCheck(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
  } catch (err) {
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
      const c = e as { constraint?: string; message?: string }
      if (c.constraint === 'roles_custom_role_has_no_plaintext' || c.message?.includes('roles_custom_role_has_no_plaintext')) return true
    }
    throw err
  }
  return false
}

afterAll(async () => {
  await db.delete(roles).where(inArray(roles.id, created))
})

describe('roles_custom_role_has_no_plaintext', () => {
  it('accepts a custom role with no name, an empty description and slug = id', async () => {
    const id = `role-ok-${suite}`
    await insert({ id, isDefault: false, name: null, description: '' })
    const [row] = await db.select().from(roles).where(eq(roles.id, id))
    expect(row.name).toBeNull()
  })

  it('accepts a seeded default carrying a plaintext name, description and slug', async () => {
    await insert({ id: `role-default-${suite}`, slug: `default-${suite}`, isDefault: true, name: 'Default', description: 'shipped' })
  })

  it('refuses a custom role with a plaintext name', async () => {
    expect(await refusedByCheck(() => insert({ id: `role-name-${suite}`, isDefault: false, name: 'Leaked' }))).toBe(true)
  })

  it('refuses a custom role with a plaintext description', async () => {
    expect(await refusedByCheck(() => insert({ id: `role-desc-${suite}`, isDefault: false, description: 'Leaked' }))).toBe(true)
  })

  it('refuses a custom role whose slug is not its id', async () => {
    expect(await refusedByCheck(() => insert({ id: `role-slug-${suite}`, slug: `leaked-${suite}`, isDefault: false }))).toBe(true)
  })

  it('refuses a role whose is_default is NULL and carries a name', async () => {
    expect(await refusedByCheck(() => insert({ id: `role-null-${suite}`, isDefault: null, name: 'Leaked' }))).toBe(true)
  })

  it('refuses an update that writes a name onto a custom role', async () => {
    const id = `role-upd-${suite}`
    await insert({ id, isDefault: false })
    expect(await refusedByCheck(() => db.update(roles).set({ name: 'Leaked' }).where(eq(roles.id, id)))).toBe(true)
  })
})
