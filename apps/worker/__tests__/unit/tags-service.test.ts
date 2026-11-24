import { describe, it, expect, vi } from 'vitest'
import { TagsService } from '../../services/tags'
import { ServiceError } from '../../services/service-error'

// ---------------------------------------------------------------------------
// Row helper
// ---------------------------------------------------------------------------

function makeTagRow(overrides: Partial<{
  id: string
  hubId: string
  name: string
  encryptedLabel: string
  color: string
  encryptedCategory: string | null
  createdBy: string
  createdAt: Date
}> = {}) {
  return {
    id: 'tag-1',
    hubId: 'hub-1',
    name: 'urgent',
    encryptedLabel: 'enc-label',
    color: '#6b7280',
    encryptedCategory: null,
    createdBy: 'pk-admin',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createTag
// ---------------------------------------------------------------------------

describe('TagsService — createTag', () => {
  it('inserts and returns a tag row', async () => {
    const row = makeTagRow({ id: 'tag-new' })
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([row]),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    const result = await svc.createTag({
      id: 'tag-new',
      hubId: 'hub-1',
      name: 'urgent',
      encryptedLabel: 'enc-label',
      createdBy: 'pk-admin',
    })

    expect(result.id).toBe('tag-new')
    expect(result.name).toBe('urgent')
    expect(result.color).toBe('#6b7280')
  })

  it('uses default color when none provided', async () => {
    const row = makeTagRow({ color: '#6b7280' })
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([row]),
    })
    const db = {
      insert: vi.fn().mockReturnValue({ values: insertValues }),
    }

    const svc = new TagsService(db as never)
    await svc.createTag({
      id: 'tag-1',
      hubId: 'hub-1',
      name: 'urgent',
      encryptedLabel: 'enc-label',
      createdBy: 'pk-admin',
    })

    const callArg = insertValues.mock.calls[0][0] as { color: string }
    expect(callArg.color).toBe('#6b7280')
  })

  it('uses provided color', async () => {
    const row = makeTagRow({ color: '#ff0000' })
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([row]),
    })
    const db = {
      insert: vi.fn().mockReturnValue({ values: insertValues }),
    }

    const svc = new TagsService(db as never)
    await svc.createTag({
      id: 'tag-1',
      hubId: 'hub-1',
      name: 'hot',
      encryptedLabel: 'enc-label',
      color: '#ff0000',
      createdBy: 'pk-admin',
    })

    const callArg = insertValues.mock.calls[0][0] as { color: string }
    expect(callArg.color).toBe('#ff0000')
  })
})

// ---------------------------------------------------------------------------
// getTag
// ---------------------------------------------------------------------------

describe('TagsService — getTag', () => {
  it('returns tag row', async () => {
    const row = makeTagRow()
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([row]),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    const result = await svc.getTag('tag-1', 'hub-1')
    expect(result.id).toBe('tag-1')
  })

  it('throws 404 when tag not found', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    await expect(svc.getTag('nonexistent', 'hub-1')).rejects.toThrow(ServiceError)
    await expect(svc.getTag('nonexistent', 'hub-1')).rejects.toMatchObject({ status: 404 })
  })
})

// ---------------------------------------------------------------------------
// listTags
// ---------------------------------------------------------------------------

describe('TagsService — listTags', () => {
  it('returns tags ordered by name', async () => {
    const rows = [makeTagRow({ id: 'tag-1', name: 'a' }), makeTagRow({ id: 'tag-2', name: 'b' })]
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    const result = await svc.listTags('hub-1')
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('a')
  })

  it('returns empty array when no tags', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    const result = await svc.listTags('hub-1')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// updateTag
// ---------------------------------------------------------------------------

describe('TagsService — updateTag', () => {
  it('returns existing tag when no updates provided', async () => {
    const row = makeTagRow()
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([row]),
        }),
      }),
      update: vi.fn(),
    }

    const svc = new TagsService(db as never)
    const result = await svc.updateTag('tag-1', 'hub-1', {})
    expect(result.id).toBe('tag-1')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('updates encryptedLabel', async () => {
    const updatedRow = makeTagRow({ encryptedLabel: 'new-enc-label' })
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    const result = await svc.updateTag('tag-1', 'hub-1', { encryptedLabel: 'new-enc-label' })
    expect(result.encryptedLabel).toBe('new-enc-label')
  })

  it('updates color', async () => {
    const updatedRow = makeTagRow({ color: '#abc123' })
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    const result = await svc.updateTag('tag-1', 'hub-1', { color: '#abc123' })
    expect(result.color).toBe('#abc123')
  })

  it('throws 404 when tag not found on update', async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    await expect(svc.updateTag('nonexistent', 'hub-1', { color: '#000' }))
      .rejects.toThrow(ServiceError)
  })
})

// ---------------------------------------------------------------------------
// deleteTag
// ---------------------------------------------------------------------------

describe('TagsService — deleteTag', () => {
  it('deletes tag successfully', async () => {
    const db = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'tag-1' }]),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    await expect(svc.deleteTag('tag-1', 'hub-1')).resolves.toBeUndefined()
  })

  it('throws 404 when tag not found on delete', async () => {
    const db = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const svc = new TagsService(db as never)
    await expect(svc.deleteTag('nonexistent', 'hub-1')).rejects.toThrow(ServiceError)
  })
})
