import { z } from 'zod'

/**
 * The parts of a Zod 4 internal def this module reads. `_zod.def` is typed as
 * the base `$ZodTypeDef`, which does not expose `innerType`; every wrapper
 * (`optional`, `nullable`, `default`, `prefault`) carries one.
 */
type WrapperDef = { type: string; innerType?: z.ZodType }

const defOf = (field: z.ZodType): WrapperDef => field._zod.def as unknown as WrapperDef

/**
 * Derive a PATCH (partial update) body schema from a create body schema.
 *
 * `ZodObject.partial()` alone is NOT safe for PATCH bodies. It makes every key
 * optional but leaves each field's inner `.default()` wrapper in place, so
 * parsing materialises a value for every key the client omitted:
 *
 * ```
 * const update = createRecordBodySchema.partial()
 * update.parse({ statusHash: 'x' })
 * // => { statusHash: 'x', assignedTo: [], blindIndexes: {} }
 * ```
 *
 * A handler that writes every defined key (`if (input.k !== undefined) ...`)
 * then overwrites data the client never mentioned. For records that destroys
 * the assignee list and the blind indexes — client-computed HMACs the server
 * cannot rebuild (see issue #1643).
 *
 * The defaults cannot simply be removed from the create schemas: CLAUDE.md
 * requires `.optional().default(value)` there because the Kotlin codegen
 * post-processor reads `"default"` out of the emitted JSON Schema to inject
 * `@Serializable` defaults. `forPatch` therefore strips the defaults only on
 * the PATCH derivation, leaving the create schema — and its generated mobile
 * types — untouched.
 *
 * Only the *top-level* wrapper chain of each key is stripped. Defaults nested
 * inside an object or array element are left alone on purpose: if the client
 * sends such a field at all it sends the whole value, so applying that value's
 * own defaults is correct.
 *
 * Returns exactly the type `schema.partial()` returns: stripping a `.default()`
 * that sits under an `.optional()` changes neither the input nor the output type
 * of the field (both were already `T | undefined`), only the runtime behaviour.
 */
export function forPatch<T extends z.ZodObject>(schema: T): ReturnType<T['partial']> {
  const partialed = schema.partial()
  const shape: Record<string, z.ZodType> = {}

  for (const [key, field] of Object.entries(partialed.shape)) {
    shape[key] = stripOuterDefaults(field as z.ZodType)
  }

  // Clone rather than rebuild with z.object() so the object's own
  // configuration (unknown-key handling, catchall) survives.
  const def = { ...partialed._zod.def, shape } as typeof partialed._zod.def
  return z.clone(partialed, def) as ReturnType<T['partial']>
}

/**
 * Remove every `default`/`prefault` wrapper from a field's outer wrapper chain,
 * preserving the `optional`/`nullable` wrappers around them.
 *
 * `.optional().default(v)` builds `default(optional(inner))`, and `.partial()`
 * wraps that again as `optional(default(optional(inner)))`. Stripping yields
 * `optional(inner)`.
 */
function stripOuterDefaults(field: z.ZodType): z.ZodType {
  const def = defOf(field)
  if (!def.innerType) return field

  switch (def.type) {
    case 'default':
    case 'prefault':
      return stripOuterDefaults(def.innerType)
    case 'optional': {
      const inner = stripOuterDefaults(def.innerType)
      // Collapse optional(optional(x)) — identical semantics, simpler schema.
      return defOf(inner).type === 'optional' ? inner : z.optional(inner)
    }
    case 'nullable':
      return z.nullable(stripOuterDefaults(def.innerType))
    default:
      return field
  }
}
