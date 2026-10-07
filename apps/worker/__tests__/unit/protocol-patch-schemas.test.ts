import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import * as schemaExports from '@protocol/schemas'
import { forPatch } from '@protocol/schemas/patch'

/**
 * Rails for issue #1643.
 *
 * `ZodObject.partial()` makes a key optional but leaves the field's inner
 * `.default()` in place, so parsing a PATCH body materialises a value for every
 * key the client omitted. A handler that writes each defined key then destroys
 * data the client never mentioned — for records, the assignee list and the
 * blind indexes, which are client-computed HMACs the server cannot rebuild.
 *
 * Both tests below enumerate the schemas programmatically. There is no
 * hand-written list to fall out of date: a new PATCH schema is covered the
 * moment it is exported.
 */

/**
 * The parts of a Zod 4 internal def these walks read. `_zod.def` is typed as the
 * base `$ZodTypeDef`, which exposes none of the per-type members below.
 */
type RawDef = {
  type: string
  innerType?: z.ZodType
  shape?: Record<string, z.ZodType>
  element?: z.ZodType
  valueType?: z.ZodType
  options?: z.ZodType[]
  items?: z.ZodType[]
  left?: z.ZodType
  right?: z.ZodType
  out?: z.ZodType
}

const defOf = (node: z.ZodType): RawDef => node._zod.def as unknown as RawDef

/**
 * Every exported Zod schema, under the same auto-discovery rule the codegen
 * registry uses (`packages/protocol/tools/schema-registry.ts`): an export whose
 * name ends in `Schema` and whose value is a `ZodType`.
 */
function exportedSchemas(): Array<[string, z.ZodType]> {
  return Object.entries(schemaExports as Record<string, unknown>)
    .filter((entry): entry is [string, z.ZodType] =>
      entry[0].endsWith('Schema') && entry[1] instanceof z.ZodType)
}

/**
 * Collect every field whose wrapper chain nests a `default` *inside* an
 * `optional`. That shape is the structural fingerprint of `.partial()` applied
 * over a `.optional().default(v)` field:
 *
 *   `.optional().default(v)`  builds  default(optional(inner))   — default outermost, fine
 *   `.partial()` over it      builds  optional(default(...))     — the #1643 defect
 *
 * Nobody writes `.default(v).optional()` by hand (CLAUDE.md mandates the other
 * order for codegen), so a hit here means a partial was taken over a defaulted
 * field without `forPatch`. This catches all seven schemas in #1643, including
 * the five platform-settings sub-schemas that the `parse({}) === {}` check below
 * cannot see, because their parent key is itself `.optional()`.
 */
function optionalWrappedDefaults(root: z.ZodType, rootName: string): string[] {
  const hits: string[] = []
  const seen = new Set<unknown>()

  const visit = (node: z.ZodType | undefined, path: string, insideOptional: boolean): void => {
    if (!node || seen.has(node)) return
    seen.add(node)

    const def = defOf(node)
    switch (def.type) {
      case 'optional':
        visit(def.innerType, path, true)
        return
      case 'nullable':
      case 'readonly':
      case 'nonoptional':
        visit(def.innerType, path, insideOptional)
        return
      case 'default':
      case 'prefault':
        if (insideOptional) hits.push(path)
        visit(def.innerType, path, insideOptional)
        return
      case 'object':
      case 'interface':
        for (const [key, field] of Object.entries(def.shape ?? {})) {
          visit(field, `${path}.${key}`, false)
        }
        return
      case 'array':
        visit(def.element, `${path}[]`, false)
        return
      case 'record':
      case 'map':
        visit(def.valueType, `${path}{}`, false)
        return
      case 'union':
        for (const option of def.options ?? []) visit(option, path, insideOptional)
        return
      case 'intersection':
        visit(def.left, path, insideOptional)
        visit(def.right, path, insideOptional)
        return
      case 'tuple':
        for (const [i, item] of (def.items ?? []).entries()) {
          visit(item, `${path}[${i}]`, false)
        }
        return
      case 'pipe':
        visit(def.out, path, insideOptional)
        return
      default:
        return
    }
  }

  visit(root, rootName, false)
  return hits
}

describe('protocol schemas — PATCH bodies must not materialise defaults (#1643)', () => {
  it('no exported schema nests a .default() inside an .optional()', () => {
    const violations = exportedSchemas()
      .flatMap(([name, schema]) => optionalWrappedDefaults(schema, name))

    expect(violations, [
      'These fields carry a .default() underneath an .optional(), which is what',
      '.partial() produces over a .optional().default(v) field. Derive the PATCH',
      "schema with forPatch() from '@protocol/schemas/patch' instead of .partial().",
    ].join('\n')).toEqual([])
  })

  it('every PATCH body schema parses {} to {}', () => {
    const patchBodies = exportedSchemas()
      .filter(([name, schema]) => /^(update|patch)[A-Z].*BodySchema$/.test(name)
        && schema instanceof z.ZodObject)

    // Sanity: the enumeration must actually find the schemas this guards.
    expect(patchBodies.length).toBeGreaterThan(15)
    expect(patchBodies.map(([name]) => name)).toContain('updateRecordBodySchema')

    const materialised = patchBodies.flatMap(([name, schema]) => {
      const result = schema.safeParse({})
      // A body that *requires* a field is a full-replacement body, not a PATCH
      // derivation; it cannot leak defaults into an omitted-key write.
      if (!result.success) return []
      const keys = Object.keys(result.data as Record<string, unknown>)
      return keys.length === 0 ? [] : [`${name} -> ${JSON.stringify(result.data)}`]
    })

    expect(materialised, 'a PATCH body parsed from {} must stay {}').toEqual([])
  })
})

describe('forPatch', () => {
  const base = z.object({
    kept: z.string(),
    defaulted: z.array(z.string()).optional().default([]),
    alreadyOptional: z.string().optional(),
    nested: z.object({ innerDefault: z.boolean().optional().default(true) }).optional(),
  })

  it('strips the inner defaults that .partial() leaves behind', () => {
    // Document the Zod behaviour this helper exists for.
    expect(base.partial().parse({})).toEqual({ defaulted: [] })
    expect(forPatch(base).parse({})).toEqual({})
  })

  it('still lets a client clear a field deliberately', () => {
    expect(forPatch(base).parse({ defaulted: [] })).toEqual({ defaulted: [] })
    expect(forPatch(base).parse({ kept: 'x' })).toEqual({ kept: 'x' })
  })

  it('leaves defaults nested inside a sent value alone', () => {
    // The client sent `nested` in full, so that object's own defaults apply.
    expect(forPatch(base).parse({ nested: {} })).toEqual({ nested: { innerDefault: true } })
  })

  it('keeps validation and unknown-key handling intact', () => {
    expect(forPatch(base).safeParse({ kept: 1 }).success).toBe(false)
    expect(forPatch(z.object({ a: z.string() }).strict()).safeParse({ b: 1 }).success).toBe(false)
  })
})
