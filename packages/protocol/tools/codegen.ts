#!/usr/bin/env bun
/**
 * Protocol codegen tool.
 *
 * Generates Swift structs and Kotlin data classes from Zod schemas
 * (via toJSONSchema()) defined in packages/protocol/schemas/.
 * Also generates crypto label constants.
 *
 * Usage:
 *   bun run codegen           # Generate all platform types
 *   bun run codegen:check     # Check generated files are up-to-date (local pre-push gate)
 */

import {
  quicktype,
  InputData,
  JSONSchemaInput,
  JSONSchemaStore,
  type LanguageName,
} from 'quicktype-core'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getSchemaRegistry } from './schema-registry'

const CHECK_MODE = process.argv.includes('--check')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const GENERATED_DIR = resolve(__dirname, '../generated')
const CRYPTO_LABELS_FILE = resolve(__dirname, '../crypto-labels.json')
const LABELS_RS_FILE = resolve(__dirname, '../../crypto/src/labels.rs')

/** Get the array at `key`, creating an empty one first if absent, and return it for mutation. */
function getOrCreateArray<K, V>(map: Map<K, V[]>, key: K): V[] {
  const existing = map.get(key)
  if (existing) return existing
  const created: V[] = []
  map.set(key, created)
  return created
}

/** Get the Set at `key`, creating an empty one first if absent, and return it for mutation. */
function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  const existing = map.get(key)
  if (existing) return existing
  const created = new Set<V>()
  map.set(key, created)
  return created
}

/** Get the Map at `key`, creating an empty one first if absent, and return it for mutation. */
function getOrCreateMap<K1, K2, V>(map: Map<K1, Map<K2, V>>, key: K1): Map<K2, V> {
  const existing = map.get(key)
  if (existing) return existing
  const created = new Map<K2, V>()
  map.set(key, created)
  return created
}

/**
 * Schema store backed by the full registry. Resolves $ref addresses by name
 * so that any future schema using $defs or z.lazy() resolves correctly.
 */
class FlatSchemaStore extends JSONSchemaStore {
  private readonly schemaMap: Map<string, object>

  constructor(schemas: Array<{ name: string; schema: string }>) {
    super()
    this.schemaMap = new Map(schemas.map(({ name, schema }) => [name, JSON.parse(schema)]))
  }

  async fetch(address: string): Promise<object | undefined> {
    return this.schemaMap.get(address)
  }
}

/**
 * Recursively remove "additionalProperties" from a JSON Schema object.
 * z.looseObject() emits additionalProperties: {} which causes quicktype to add
 * open-map index signatures to generated types. Strip it before passing to quicktype.
 */
function stripAdditionalProperties(schema: object): object {
  const s = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  // Only strip unconstrained additionalProperties (empty object {} or true from z.looseObject).
  // Keep typed additionalProperties like { type: "number" } from z.record(z.string(), z.number()).
  const ap = s['additionalProperties']
  if (ap === true || (typeof ap === 'object' && ap !== null && Object.keys(ap).length === 0)) {
    delete s['additionalProperties']
  }
  if (s['properties'] && typeof s['properties'] === 'object') {
    for (const key of Object.keys(s['properties'] as object)) {
      const prop = (s['properties'] as Record<string, object>)[key]
      if (prop && typeof prop === 'object') {
        (s['properties'] as Record<string, object>)[key] = stripAdditionalProperties(prop) as object
      }
    }
  }
  if (Array.isArray(s['items'])) {
    s['items'] = (s['items'] as object[]).map(stripAdditionalProperties)
  } else if (s['items'] && typeof s['items'] === 'object') {
    s['items'] = stripAdditionalProperties(s['items'] as object)
  }
  return s
}

/**
 * Canonical JSON representation for hashing: sorted keys, no whitespace.
 */
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']'
  const sorted = Object.keys(obj as Record<string, unknown>).sort()
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])).join(',') + '}'
}

/**
 * Singularize a PascalCase noun for array-item naming.
 * Handles common English plural patterns found in our schemas.
 */
function singularize(name: string): string {
  // Deliveries → Delivery, Categories → Category
  if (name.endsWith('ies') && name.length > 3) {
    return name.slice(0, -3) + 'y'
  }
  // Statuses → Status, Indexes → Index, Addresses → Address
  if (name.endsWith('es') && name.length > 2) {
    const stem = name.slice(0, -2)
    if (/[sxz]$/i.test(stem) || /sh$/i.test(stem) || /ch$/i.test(stem)) {
      return stem
    }
  }
  // Envelopes → Envelope, Members → Member (but not "ss" words like Addresses)
  if (name.endsWith('s') && !name.endsWith('ss') && name.length > 1) {
    return name.slice(0, -1)
  }
  return name
}

/**
 * Derive a PascalCase $def name from the property path leading to the inline object.
 * e.g. "adminEnvelopes" → "AdminEnvelope" (strip trailing 's' for arrays),
 *      "providerType" → "ProviderType"
 *
 * Prefixed with "Shared" to avoid conflicts with Swift/Kotlin built-in types
 * (Error, Group, Location, etc.) and to signal these are extracted sub-schemas.
 */
function defNameFromPath(propertyName: string, isArrayItem: boolean): string {
  let name = propertyName.charAt(0).toUpperCase() + propertyName.slice(1)
  if (isArrayItem) name = singularize(name)
  return 'Shared' + name
}

/**
 * Deduplicate identical anonymous inline objects across all schemas.
 *
 * Walks each schema tree collecting inline `{ type: "object", properties: ... }` and
 * inline `{ type: "string", enum: [...] }` sub-schemas. Groups them by canonical JSON hash.
 * When duplicates are found (same shape appears in 2+ locations), extracts one copy as a
 * new top-level schema entry and replaces all inline occurrences with `{ "$ref": "DefName" }`.
 *
 * quicktype's FlatSchemaStore resolves top-level `$ref` addresses by name, so these
 * references produce stable named types instead of Purple/Fluffy invented names.
 */
function deduplicateAnonymousSchemas(
  schemas: Array<{ name: string; schema: string }>,
): Array<{ name: string; schema: string }> {
  type InlineRef = {
    schemaIdx: number
    path: string[] // JSON pointer path segments
    propertyName: string
    isArrayItem: boolean
    canonical: string
  }

  const parsed = schemas.map(s => JSON.parse(s.schema) as Record<string, unknown>)
  const existingNames = new Set(schemas.map(s => s.name))
  const inlinesByHash = new Map<string, InlineRef[]>()

  function collectInlines(
    node: Record<string, unknown>,
    path: string[],
    schemaIdx: number,
  ) {
    if (!node || typeof node !== 'object') return
    const props = node['properties'] as Record<string, Record<string, unknown>> | undefined
    if (!props) return

    for (const [propName, propSchema] of Object.entries(props)) {
      if (!propSchema || typeof propSchema !== 'object') continue
      const propPath = [...path, 'properties', propName]

      // Inline object with properties
      if (propSchema['type'] === 'object' && propSchema['properties']) {
        const canon = canonicalize(propSchema)
        const ref: InlineRef = { schemaIdx, path: propPath, propertyName: propName, isArrayItem: false, canonical: canon }
        getOrCreateArray(inlinesByHash, canon).push(ref)
        collectInlines(propSchema, propPath, schemaIdx)
      }

      // Inline enum
      if (propSchema['type'] === 'string' && Array.isArray(propSchema['enum'])) {
        const canon = canonicalize(propSchema)
        const ref: InlineRef = { schemaIdx, path: propPath, propertyName: propName, isArrayItem: false, canonical: canon }
        getOrCreateArray(inlinesByHash, canon).push(ref)
      }

      // Array items
      if (propSchema['type'] === 'array' && propSchema['items']) {
        const items = propSchema['items'] as Record<string, unknown>
        if (items['type'] === 'object' && items['properties']) {
          const itemPath = [...propPath, 'items']
          const canon = canonicalize(items)
          const ref: InlineRef = { schemaIdx, path: itemPath, propertyName: propName, isArrayItem: true, canonical: canon }
          getOrCreateArray(inlinesByHash, canon).push(ref)
          collectInlines(items, itemPath, schemaIdx)
        }
      }

      // anyOf/oneOf variants (e.g., nullable objects)
      for (const combiner of ['anyOf', 'oneOf'] as const) {
        const variants = propSchema[combiner] as Record<string, unknown>[] | undefined
        if (!Array.isArray(variants)) continue
        for (let i = 0; i < variants.length; i++) {
          const variant = variants[i]
          if (!variant || typeof variant !== 'object') continue
          if (variant['type'] === 'object' && variant['properties']) {
            const varPath = [...propPath, combiner, String(i)]
            const canon = canonicalize(variant)
            const ref: InlineRef = { schemaIdx, path: varPath, propertyName: propName, isArrayItem: false, canonical: canon }
            getOrCreateArray(inlinesByHash, canon).push(ref)
            collectInlines(variant, varPath, schemaIdx)
          }
          if (variant['type'] === 'string' && Array.isArray(variant['enum'])) {
            const varPath = [...propPath, combiner, String(i)]
            const canon = canonicalize(variant)
            const ref: InlineRef = { schemaIdx, path: varPath, propertyName: propName, isArrayItem: false, canonical: canon }
            getOrCreateArray(inlinesByHash, canon).push(ref)
          }
        }
      }
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    collectInlines(parsed[i], [], i)
  }

  // Phase 2: Extract duplicates as new top-level schemas, replace with $ref.
  // Sort groups by deepest path first so inner schemas are replaced before their containers.
  const sortedGroups = [...inlinesByHash.entries()]
    .filter(([, refs]) => refs.length >= 2)
    .sort(([, a], [, b]) => {
      const maxA = Math.max(...a.map(r => r.path.length))
      const maxB = Math.max(...b.map(r => r.path.length))
      return maxB - maxA // deepest first
    })

  const extractedSchemas: Array<{ name: string; schema: string }> = []
  const usedDefNames = new Set(existingNames)

  for (const [, refs] of sortedGroups) {
    // Sort refs by parent schema name for deterministic naming on collision
    const sortedRefs = [...refs].sort((a, b) =>
      schemas[a.schemaIdx].name.localeCompare(schemas[b.schemaIdx].name),
    )

    const baseName = defNameFromPath(sortedRefs[0].propertyName, sortedRefs[0].isArrayItem)
    let defName = baseName

    if (usedDefNames.has(defName)) {
      // Disambiguate using parent schema name: SharedStatus → SharedActiveCallResponseStatus
      // Try each parent (alphabetically) until we find a unique name
      for (const ref of sortedRefs) {
        const parentName = schemas[ref.schemaIdx].name
        const propPart = baseName.replace(/^Shared/, '')
        defName = 'Shared' + parentName + propPart
        if (!usedDefNames.has(defName)) break
      }
      // Last resort: numeric suffix (should be rare)
      let suffix = 2
      while (usedDefNames.has(defName)) {
        defName = baseName + suffix++
      }
    }
    usedDefNames.add(defName)

    // Register the extracted schema as a new top-level entry
    extractedSchemas.push({ name: defName, schema: refs[0].canonical })

    // Replace each inline occurrence with a store-level $ref
    for (const ref of refs) {
      const root = parsed[ref.schemaIdx]
      let parent: Record<string, unknown> = root
      let valid = true
      for (let i = 0; i < ref.path.length - 1; i++) {
        const next = parent[ref.path[i]]
        if (!next || typeof next !== 'object') { valid = false; break }
        parent = next as Record<string, unknown>
      }
      if (!valid) continue
      const lastKey = ref.path[ref.path.length - 1]
      // Preserve "default" value from the original inline schema so that
      // post-processors (Kotlin/Swift default injection) can still read it.
      const original = parent[lastKey] as Record<string, unknown> | undefined
      const replacement: Record<string, unknown> = { '$ref': defName }
      if (original && typeof original === 'object' && 'default' in original) {
        replacement['default'] = original['default']
      }
      parent[lastKey] = replacement
    }
  }

  console.log(`  Deduplicated ${extractedSchemas.length} anonymous sub-schemas into top-level types`)

  const updatedSchemas = parsed.map((p, i) => ({
    name: schemas[i].name,
    schema: JSON.stringify(p),
  }))

  return [...updatedSchemas, ...extractedSchemas]
}

/**
 * Build integer field maps from JSON schemas.
 * Returns:
 *  - perType: Map<TypeName, Set<fieldName>> for per-type conversion
 *  - alwaysInt: Set<fieldName> for fields that are ALWAYS integer across all schemas
 *    (never appear as "type": "number"), safe for global conversion
 */
function buildIntegerFieldMaps(
  schemas: Array<{ name: string; schema: string }>,
): { perType: Map<string, Set<string>>; alwaysInt: Set<string> } {
  const perType = new Map<string, Set<string>>()
  // Track which fields appear as integer vs number globally
  const asInt = new Map<string, number>()
  const asNum = new Map<string, number>()

  for (const { name, schema } of schemas) {
    const parsed = JSON.parse(schema) as Record<string, unknown>
    collectIntegerFieldsDeep(parsed, name, perType, asInt, asNum)
  }

  // Fields that are ALWAYS integer (never appear as number)
  const alwaysInt = new Set<string>()
  for (const [field, count] of asInt) {
    if (count > 0 && !asNum.has(field)) {
      alwaysInt.add(field)
    }
  }

  return { perType, alwaysInt }
}

function collectIntegerFieldsDeep(
  schema: Record<string, unknown>,
  typeName: string,
  perType: Map<string, Set<string>>,
  asInt: Map<string, number>,
  asNum: Map<string, number>,
) {
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined
  if (!props) return

  for (const [propName, propSchema] of Object.entries(props)) {
    if (!propSchema || typeof propSchema !== 'object') continue

    if (propSchema['type'] === 'integer') {
      getOrCreateSet(perType, typeName).add(propName)
      asInt.set(propName, (asInt.get(propName) ?? 0) + 1)
      continue
    }

    if (propSchema['type'] === 'number') {
      asNum.set(propName, (asNum.get(propName) ?? 0) + 1)
      continue
    }

    // Check anyOf/oneOf for nullable patterns
    for (const combiner of ['anyOf', 'oneOf'] as const) {
      const variants = propSchema[combiner] as Record<string, unknown>[] | undefined
      if (!Array.isArray(variants)) continue
      const hasInt = variants.some(v => v['type'] === 'integer')
      const hasNum = variants.some(v => v['type'] === 'number')
      if (hasInt) {
        getOrCreateSet(perType, typeName).add(propName)
        asInt.set(propName, (asInt.get(propName) ?? 0) + 1)
      }
      if (hasNum) {
        asNum.set(propName, (asNum.get(propName) ?? 0) + 1)
      }
      // Also recurse into nullable objects
      for (const v of variants) {
        if (v && v['type'] === 'object' && v['properties']) {
          collectIntegerFieldsDeep(v as Record<string, unknown>, typeName + propName.charAt(0).toUpperCase() + propName.slice(1), perType, asInt, asNum)
        }
      }
    }

    // Recurse into nested objects and array items
    if (propSchema['type'] === 'object' && propSchema['properties']) {
      collectIntegerFieldsDeep(
        propSchema as Record<string, unknown>,
        typeName + propName.charAt(0).toUpperCase() + propName.slice(1),
        perType, asInt, asNum,
      )
    }
    if (propSchema['type'] === 'array') {
      const items = propSchema['items'] as Record<string, unknown> | undefined
      if (items && items['type'] === 'object' && items['properties']) {
        collectIntegerFieldsDeep(items, typeName + propName.charAt(0).toUpperCase() + propName.slice(1), perType, asInt, asNum)
      }
    }
  }
}

/**
 * Case-insensitive field name matching.
 * quicktype's acronym-style may change casing (e.g., bufferTtlDays → bufferTTLDays),
 * so compare lowercase to handle these discrepancies.
 */
function fieldMatchesSet(lowerFieldName: string, fieldSet: Set<string>): boolean {
  for (const f of fieldSet) {
    if (f.toLowerCase() === lowerFieldName) return true
  }
  return false
}

/**
 * Post-process Swift output to fix integer types.
 * Replace Double with Int for fields that are "type": "integer" in their source schema.
 * Uses per-type mapping so a field named "limit" is only converted in types where it's
 * declared as integer, not in types where it's declared as number.
 */
function fixSwiftIntegerTypes(
  output: string,
  integerPerType: Map<string, Set<string>>,
  alwaysInt: Set<string>,
): string {
  if (integerPerType.size === 0 && alwaysInt.size === 0) return output

  const lines = output.split('\n')
  const result: string[] = []
  let currentType: string | null = null

  for (const line of lines) {
    // Track which struct we're inside
    const structMatch = line.match(/^struct (\w+):/)
    if (structMatch) currentType = structMatch[1]
    if (line === '}') currentType = null

    if (currentType) {
      const match = line.match(/^(\s+let\s+)([\w,\s]+)(:\s*)(Double)(\??\s*(?:$|\/\/.*$))/)
      if (match) {
        const [, prefix, fieldNames, colon, , suffix] = match
        const names = fieldNames.split(',').map(n => n.trim())
        // Try matching the current type name against the per-type map.
        // quicktype may singularize names (e.g., CustomFieldsBodyField vs CustomFieldsBodyFields),
        // so also check with 's' appended.
        const typeIntFields = integerPerType.get(currentType)
          ?? integerPerType.get(currentType + 's')

        // Convert if ALL names on this line are integer:
        // either in the per-type map for this type, or in the always-integer global set
        const allAreIntegers = names.every(n => {
          const lower = n.toLowerCase()
          return fieldMatchesSet(lower, alwaysInt)
            || (typeIntFields && fieldMatchesSet(lower, typeIntFields))
        })
        if (allAreIntegers) {
          result.push(`${prefix}${fieldNames}${colon}Int${suffix}`)
          continue
        }
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Post-process Kotlin output to fix integer types.
 * Replace Long with Int for fields that are "type": "integer" in their source schema.
 */
function fixKotlinIntegerTypes(
  output: string,
  integerPerType: Map<string, Set<string>>,
  alwaysInt: Set<string>,
): string {
  if (integerPerType.size === 0 && alwaysInt.size === 0) return output

  const lines = output.split('\n')
  const result: string[] = []
  let currentType: string | null = null

  for (const line of lines) {
    const classMatch = line.match(/^data class (\w+)\s*\(/)
    if (classMatch) currentType = classMatch[1]
    if (line.trim() === ')' || line.trim() === ') {') currentType = null

    if (currentType) {
      const match = line.match(/^(\s+val\s+)(\w+)(:\s*)(Long)(\??(?:\s*=\s*.+?)?,?\s*$)/)
      if (match) {
        const [, prefix, fieldName, colon, , suffix] = match
        const lowerField = fieldName.toLowerCase()
        const typeIntFields = integerPerType.get(currentType)
          ?? integerPerType.get(currentType + 's')
        // Match field names case-insensitively because quicktype's acronym-style
        // may change casing (e.g., bufferTtlDays → bufferTTLDays)
        const isInt = fieldMatchesSet(lowerField, alwaysInt)
          || (typeIntFields && fieldMatchesSet(lowerField, typeIntFields))
        if (isInt) {
          const fixedSuffix = suffix.replace(/(\s*=\s*)(\d+)L/g, '$1$2')
          result.push(`${prefix}${fieldName}${colon}Int${fixedSuffix}`)
          continue
        }
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

// Generate types for a target language from all schemas
async function generateForLanguage(
  language: LanguageName,
  schemas: Array<{ name: string; schema: string }>,
  rendererOptions: Record<string, string> = {},
): Promise<string[]> {
  const store = new FlatSchemaStore(schemas)
  const schemaInput = new JSONSchemaInput(store)

  for (const { name, schema } of schemas) {
    await schemaInput.addSource({ name, schema })
  }

  const inputData = new InputData()
  inputData.addInput(schemaInput)

  const result = await quicktype({
    inputData,
    lang: language,
    rendererOptions,
  })

  return result.lines
}

/**
 * Numeric label IDs, read from `LABEL_REGISTRY` in packages/crypto/src/labels.rs.
 *
 * An HPKE envelope carries a `labelId`, and `hpke_open` resolves it through that
 * registry and rejects the envelope unless it resolves to the label the caller
 * expects (the Albrecht check). The IDs therefore have exactly one authority —
 * the Rust array — and it is NOT the key order of crypto-labels.json (the two
 * already disagree from index 7 on). Clients that rebuild an envelope from the
 * wire `{enc, ct}` pair must use these IDs; a hand-written number is how iOS came
 * to open every message, hub key and call record as `labelId 0` (#1328).
 *
 * Throws if the registry cannot be parsed or disagrees with crypto-labels.json,
 * so a drifted registry fails codegen instead of generating wrong IDs.
 */
function readLabelRegistryIds(labels: Record<string, string>): Map<string, number> {
  const source = readFileSync(LABELS_RS_FILE, 'utf-8')
  const block = /pub const LABEL_REGISTRY: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(source)
  if (!block) {
    throw new Error(`codegen: could not find LABEL_REGISTRY in ${LABELS_RS_FILE}`)
  }
  const entries = block[1]
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').trim())
    .join('')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)

  const ids = new Map<string, number>()
  entries.forEach((entry, index) => {
    if (entry === '""') return // tombstoned index — never reused, never resolvable
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry)) {
      throw new Error(`codegen: unexpected LABEL_REGISTRY entry at index ${index}: ${entry}`)
    }
    if (!(entry in labels)) {
      throw new Error(`codegen: LABEL_REGISTRY[${index}] = ${entry} is not defined in crypto-labels.json`)
    }
    if (ids.has(entry)) {
      throw new Error(`codegen: ${entry} appears twice in LABEL_REGISTRY (indices ${ids.get(entry)} and ${index})`)
    }
    if (index > 255) {
      throw new Error(`codegen: LABEL_REGISTRY index ${index} does not fit the u8 labelId field`)
    }
    ids.set(entry, index)
  })

  // A label string shared by two names would make the generated label→ID lookup
  // ambiguous (and is itself a domain-separation violation).
  const seenValues = new Map<string, string>()
  for (const [name, value] of Object.entries(labels)) {
    const other = seenValues.get(value)
    if (other) {
      throw new Error(`codegen: ${other} and ${name} share the label string "${value}"`)
    }
    seenValues.set(value, name)
  }

  const missing = Object.keys(labels).filter(name => !ids.has(name))
  if (missing.length > 0) {
    throw new Error(`codegen: crypto-labels.json labels missing from LABEL_REGISTRY: ${missing.join(', ')}`)
  }

  // Each constant's value in labels.rs must match the JSON, or an ID would point
  // at a different string on the Rust side than the one clients pass as expectedLabel.
  for (const [name, value] of Object.entries(labels)) {
    const def = new RegExp(`pub const ${name}: &str =\\s*"([^"]*)";`).exec(source)
    if (!def) {
      throw new Error(`codegen: no \`pub const ${name}\` in ${LABELS_RS_FILE}`)
    }
    if (def[1] !== value) {
      throw new Error(`codegen: ${name} is "${def[1]}" in labels.rs but "${value}" in crypto-labels.json`)
    }
  }
  return ids
}

// Generate Swift crypto labels
function generateSwiftCryptoLabels(labels: Record<string, string>, labelIds: Map<string, number>): string {
  const lines = [
    '// Auto-generated by packages/protocol/tools/codegen.ts',
    '// Do not edit manually.',
    '',
    'import Foundation',
    '',
    '/// Cryptographic domain separation labels for all llamenos crypto operations.',
    '/// Every ECIES derivation, HKDF context, HMAC key, and Schnorr signature binding',
    '/// uses a unique context string from this enum.',
    'enum CryptoLabels {',
  ]
  for (const [name, value] of Object.entries(labels)) {
    lines.push(`    static let ${name} = "${value}"`)
  }
  lines.push(
    '}',
    '',
    '/// Numeric HPKE envelope `labelId` for each label, from `LABEL_REGISTRY` in',
    '/// packages/crypto/src/labels.rs (NOT the key order of crypto-labels.json).',
    '/// Rebuild a wire `{enc, ct}` pair with `CryptoLabelIds.id(for:)` of the label',
    '/// you open with — never a literal.',
    'enum CryptoLabelIds {',
  )
  for (const name of Object.keys(labels)) {
    lines.push(`    static let ${name}: UInt8 = ${labelIds.get(name)}`)
  }
  lines.push('', '    /// Every registered label string and its ID.', '    static let byLabel: [String: UInt8] = [')
  for (const name of Object.keys(labels)) {
    lines.push(`        CryptoLabels.${name}: ${name},`)
  }
  lines.push(
    '    ]',
    '',
    '    /// The registry ID for a label string, or nil if the label is not registered.',
    '    static func id(for label: String) -> UInt8? { byLabel[label] }',
    '}',
    '',
  )
  return lines.join('\n')
}

// Generate Rust crypto labels (reference/validation file — does NOT replace packages/crypto/src/labels.rs)
function generateRustCryptoLabels(labels: Record<string, string>): string {
  const lines = [
    '// Auto-generated by packages/protocol/tools/codegen.ts',
    '// Do not edit manually.',
    '//',
    '// NOTE: This file is a REFERENCE generated from crypto-labels.json.',
    '// The authoritative Rust label source is packages/crypto/src/labels.rs,',
    '// which includes the LABEL_REGISTRY with stable numeric indices.',
    '// Update LABEL_REGISTRY manually when adding new labels to maintain index stability.',
    '',
  ]
  for (const [name, value] of Object.entries(labels)) {
    lines.push(`pub const ${name}: &str = "${value}";`)
  }
  lines.push('')
  return lines.join('\n')
}

// Generate TypeScript crypto labels (packages/shared/crypto-labels.ts)
function generateTypeScriptCryptoLabels(labels: Record<string, string>): string {
  const lines = [
    '// Auto-generated by packages/protocol/tools/codegen.ts from crypto-labels.json',
    '// Do not edit manually.',
    '',
    '/**',
    ' * Authoritative domain separation constants for all cryptographic operations.',
    ' *',
    ' * Every ECIES derivation, HKDF context, HMAC key, and Schnorr signature binding',
    ' * uses a unique context string from this file. This prevents cross-context key',
    ' * reuse attacks where a ciphertext from one domain could be valid in another.',
    ' *',
    ' * RULES:',
    ' * 1. NEVER use raw string literals for crypto contexts — import from here',
    ' * 2. New crypto operations MUST add a new constant to crypto-labels.json before implementation',
    ' * 3. All constants are prefixed with \'llamenos:\' for collision avoidance',
    ' */',
    '',
  ]
  for (const [name, value] of Object.entries(labels)) {
    lines.push(`export const ${name} = '${value}'`)
  }
  lines.push('')
  return lines.join('\n')
}

// Generate Kotlin crypto labels
function generateKotlinCryptoLabels(labels: Record<string, string>, labelIds: Map<string, number>): string {
  const lines = [
    '// Auto-generated by packages/protocol/tools/codegen.ts',
    '// Do not edit manually.',
    '',
    'package org.llamenos.protocol',
    '',
    '/**',
    ' * Cryptographic domain separation labels for all llamenos crypto operations.',
    ' * Every ECIES derivation, HKDF context, HMAC key, and Schnorr signature binding',
    ' * uses a unique context string from this object.',
    ' */',
    'object CryptoLabels {',
  ]
  for (const [name, value] of Object.entries(labels)) {
    lines.push(`    const val ${name} = "${value}"`)
  }
  lines.push(
    '}',
    '',
    '/**',
    ' * Numeric HPKE envelope `labelId` for each label, from `LABEL_REGISTRY` in',
    ' * packages/crypto/src/labels.rs (NOT the key order of crypto-labels.json).',
    ' * Rebuild a wire `{enc, ct}` pair with `CryptoLabelIds.idFor()` of the label',
    ' * you open with — never a literal.',
    ' */',
    'object CryptoLabelIds {',
  )
  for (const name of Object.keys(labels)) {
    lines.push(`    const val ${name}: UByte = ${labelIds.get(name)}u`)
  }
  lines.push('', '    private val byLabel: Map<String, UByte> = mapOf(')
  for (const name of Object.keys(labels)) {
    lines.push(`        CryptoLabels.${name} to ${name},`)
  }
  lines.push(
    '    )',
    '',
    '    /** The registry ID for a label string, or null if the label is not registered. */',
    '    fun idFor(label: String): UByte? = byLabel[label]',
    '}',
    '',
  )
  return lines.join('\n')
}

/**
 * Strip quicktype convenience initializer extensions from Swift output,
 * keeping only struct/enum/class/typealias definitions with CodingKeys.
 * Also adds Sendable conformance alongside Codable.
 */
function stripSwiftConvenienceExtensions(lines: string[]): string {
  const result: string[] = []
  let skipDepth = 0  // brace depth when skipping a block
  let isSkipping = false

  for (const line of lines) {
    // Detect start of blocks to skip:
    // 1. extension blocks (convenience initializers)
    // 2. func newJSONDecoder/newJSONEncoder
    if (!isSkipping) {
      if (/^extension\b/.test(line) && /\{/.test(line)) {
        isSkipping = true
        skipDepth = 0
        for (const ch of line) {
          if (ch === '{') skipDepth++
          if (ch === '}') skipDepth--
        }
        if (skipDepth <= 0) isSkipping = false
        continue
      }
      if (/^func newJSON/.test(line) || /^\s+func newJSON/.test(line)) {
        isSkipping = true
        skipDepth = 0
        for (const ch of line) {
          if (ch === '{') skipDepth++
          if (ch === '}') skipDepth--
        }
        if (skipDepth <= 0) isSkipping = false
        continue
      }
    }

    // Track braces inside skipped blocks
    if (isSkipping) {
      for (const ch of line) {
        if (ch === '{') skipDepth++
        if (ch === '}') skipDepth--
      }
      if (skipDepth <= 0) isSkipping = false
      continue
    }

    // Skip standalone "// MARK: ... convenience initializers" comments
    if (/convenience initializers/.test(line)) continue
    // Skip "// MARK: - Helper functions for creating encoders and decoders"
    if (/Helper functions for creating/.test(line)) continue
    // Skip "// MARK: - Encode/decode helpers"
    if (/Encode\/decode helpers/.test(line)) continue
    // Skip orphaned decoder/encoder body lines (from stripped func declarations)
    if (/^\s+let (decoder|encoder) = JSON(De|En)coder\(\)/.test(line)) continue
    if (/^\s+if #available/.test(line) && /(dateDecod|dateEncod)/.test(line)) continue
    if (/^\s+(decoder|encoder)\.(date(De|En)codingStrategy)/.test(line)) continue
    if (/^\s+return (decoder|encoder)/.test(line)) continue

    result.push(line)
  }

  // Add Sendable to Codable structs and enums
  let output = result.join('\n')
  output = output.replace(/^(struct \w+): Codable \{/gm, '$1: Codable, Sendable {')
  output = output.replace(/^(enum \w+: String), Codable \{/gm, '$1, Codable, Sendable {')

  // Rename generated types that shadow Swift built-ins, SwiftUI types, or UniFFI types.
  // Each rename must cover the type declaration, MARK comment, and all property type references.

  // `Error` shadows Swift's Error protocol — rename to InviteError.
  output = output.replace(/^enum Error: String/gm, 'enum InviteError: String')
  output = output.replace(/\blet error: Error\?/g, 'let error: InviteError?')

  // `KeyEnvelope` conflicts with UniFFI's KeyEnvelope — rename to ProtocolKeyEnvelope.
  output = output.replace(/\bKeyEnvelope\b/g, 'ProtocolKeyEnvelope')

  // `Group` shadows SwiftUI's Group view — rename to AffinityGroupElement.
  output = output.replace(/^(struct |\/\/ MARK: - )Group\b/gm, '$1AffinityGroupElement')
  output = output.replace(/\blet groups: \[Group\]/g, 'let groups: [AffinityGroupElement]')

  // `Event` is too generic and shadows NSEvent — rename to ProtocolEvent.
  output = output.replace(/^(struct |\/\/ MARK: - )Event:/gm, '$1ProtocolEvent:')
  output = output.replace(/^(struct |\/\/ MARK: - )Event\b(?! *[A-Z])/gm, '$1ProtocolEvent')

  // `Record` is too generic (CoreData, etc.) — rename to CaseLinkRecord.
  // Only rename standalone `Record` type, not types that start with Record (e.g., RecordNotesEnvelope).
  output = output.replace(/^(struct |\/\/ MARK: - )Record:/gm, '$1CaseLinkRecord:')
  output = output.replace(/^(struct |\/\/ MARK: - )Record\b(?! *[A-Z])/gm, '$1CaseLinkRecord')
  output = output.replace(/\blet records: \[Record\]/g, 'let records: [CaseLinkRecord]')

  // `Report` is too generic — rename to CaseLinkReport (used in report-case link context).
  // Only rename standalone `Report` type, not types that start with Report (e.g., ReportResponse).
  output = output.replace(/^(struct |\/\/ MARK: - )Report:/gm, '$1CaseLinkReport:')
  output = output.replace(/^(struct |\/\/ MARK: - )Report\b(?! *[A-Z])/gm, '$1CaseLinkReport')
  output = output.replace(/\blet reports: \[Report\]/g, 'let reports: [CaseLinkReport]')

  // `Location` shadows CoreLocation types — rename to EventLocation.
  output = output.replace(/^(struct |\/\/ MARK: - )Location:/gm, '$1EventLocation:')
  output = output.replace(/^(struct |\/\/ MARK: - )Location\b(?! *[A-Z])/gm, '$1EventLocation')
  output = output.replace(/\blet location: Location\?/g, 'let location: EventLocation?')

  // `Value` shadows Swift generic Value type parameter — rename to FieldValue.
  output = output.replace(/^(enum |\/\/ MARK: - )Value:/gm, '$1FieldValue:')
  output = output.replace(/^(enum |\/\/ MARK: - )Value\b(?! *[A-Z])/gm, '$1FieldValue')
  output = output.replace(/\bValue\.self\b/g, 'FieldValue.self')
  output = output.replace(/\blet defaultValue: Value\?/g, 'let defaultValue: FieldValue?')
  output = output.replace(/\blet value: Value\?/g, 'let value: FieldValue?')

  // `Detail` is too generic — rename to ErrorDetail (used inside ErrorResponse).
  output = output.replace(/^(struct |\/\/ MARK: - )Detail:/gm, '$1ErrorDetail:')
  output = output.replace(/^(struct |\/\/ MARK: - )Detail\b(?! *[A-Z])/gm, '$1ErrorDetail')
  output = output.replace(/\blet details: \[Detail\]\?/g, 'let details: [ErrorDetail]?')

  // `Category` shadows ObjC concept and would collide with iOS app's ReportCategory —
  // rename to ReportTypeCategory.
  output = output.replace(/^(enum |\/\/ MARK: - )Category:/gm, '$1ReportTypeCategory:')
  output = output.replace(/^(enum |\/\/ MARK: - )Category\b(?! *[A-Z])/gm, '$1ReportTypeCategory')
  output = output.replace(/\blet category: Category\b/g, 'let category: ReportTypeCategory')
  // Catch remaining property references to `Category` (e.g., `let type: Category?` in SharedMetadata)
  output = output.replace(/\b: Category\b/g, ': ReportTypeCategory')

  // `Operator` is near-identical to Swift keyword `operator` — rename to FieldOperator.
  output = output.replace(/^(enum |\/\/ MARK: - )Operator:/gm, '$1FieldOperator:')
  output = output.replace(/^(enum |\/\/ MARK: - )Operator\b(?! *[A-Z])/gm, '$1FieldOperator')
  output = output.replace(/\bshowWhenOperator: Operator\b/g, 'showWhenOperator: FieldOperator')

  // `CustomFieldDefinition` conflicts with the iOS app's local CustomField.swift model —
  // rename to ProtocolCustomFieldDefinition. Only match the standalone type declaration.
  output = output.replace(/^(struct |\/\/ MARK: - )CustomFieldDefinition\b(?![A-Z])/gm, '$1ProtocolCustomFieldDefinition')

  // Types that conflict with iOS app's local model files. The generated types have different
  // shapes from the local models (iOS app uses the local versions for API decoding).
  // Rename to Protocol-prefixed names so both can coexist in the same Swift module.

  // `BlastStatus` conflicts with local Blast.swift — same enum, local adds icon/color helpers.
  output = output.replace(/\bBlastStatus\b/g, 'ProtocolBlastStatus')

  // `ConversationStatus` conflicts with local Conversation.swift — same cases, local adds displayName.
  output = output.replace(/\bConversationStatus\b/g, 'ProtocolConversationStatus')

  // `ContactIdentifier` conflicts with local Contact.swift — different shape.
  output = output.replace(/\bContactIdentifier\b(?!Type)/g, 'ProtocolContactIdentifier')

  // `ContactSearchResponse` conflicts with local Contact.swift — different shape.
  output = output.replace(/\bContactSearchResponse\b(?!Contact)/g, 'ProtocolContactSearchResponse')

  // `ContactSummary` conflicts with local Contact.swift — different shape.
  output = output.replace(/\bContactSummary\b(?!Envelope)/g, 'ProtocolContactSummary')

  // `ContactTimelineResponse` conflicts with local Contact.swift — different shape.
  output = output.replace(/\bContactTimelineResponse\b(?!Contact)/g, 'ProtocolContactTimelineResponse')

  // `ActiveCallsResponse` conflicts with local Call.swift — different shape (uses CallRecordDTO).
  output = output.replace(/\bActiveCallsResponse\b/g, 'ProtocolActiveCallsResponse')

  // `CallHistoryResponse` conflicts with local Call.swift — different shape (uses CallRecordDTO, Int fields).
  output = output.replace(/\bCallHistoryResponse\b/g, 'ProtocolCallHistoryResponse')

  // Note: CaseInteraction and EvidenceListResponse are NOT renamed — the iOS app
  // uses the generated types directly (custom duplicates removed from CaseRecord.swift).

  // Clean up consecutive blank lines
  output = output.replace(/\n{3,}/g, '\n\n')

  return output
}

/**
 * Post-process Kotlin output:
 * 1. Replace package name
 * 2. Add default values for required fields that have defaults in JSON Schema.
 *    quicktype generates `val x: Boolean` for required fields with `"default": false`,
 *    but kotlinx.serialization needs `val x: Boolean = false` to deserialize
 *    responses that omit the field (common with Zod `.default()` fields).
 * 3. Add `= emptyList()` for required List<*> fields that have `"default": []`.
 */
function postProcessKotlin(
  raw: string,
  schemas: Array<{ name: string; schema: string }>,
): string {
  const output = raw

  // Build a map of schema defaults: { TypeName: { fieldName: defaultValue } }
  const defaultsMap = new Map<string, Map<string, unknown>>()
  for (const { name, schema } of schemas) {
    try {
      const parsed = JSON.parse(schema)
      if (parsed.properties && parsed.required) {
        // Convert schema name to PascalCase type name (e.g., 'entityTypeDefinitionSchema' → 'EntityTypeDefinition')
        const typeName = name
          .replace(/Schema$/, '')
          .replace(/(^|_)(\w)/g, (_, _prefix, ch) => ch.toUpperCase())
        const fieldDefaults = new Map<string, unknown>()
        for (const [prop, def] of Object.entries(parsed.properties)) {
          const propDef = def as { default?: unknown }
          if (propDef.default !== undefined && parsed.required.includes(prop)) {
            fieldDefaults.set(prop, propDef.default)
          }
        }
        if (fieldDefaults.size > 0) {
          defaultsMap.set(typeName, fieldDefaults)
        }
      }
    } catch { /* skip non-JSON schemas */ }
  }

  // Apply defaults to Kotlin data class fields.
  // Match patterns like:
  //   val fieldName: Boolean,       → val fieldName: Boolean = false,
  //   val fieldName: Long,          → val fieldName: Long = 0,
  //   val fieldName: String,        → val fieldName: String = "",
  //   val fieldName: List<...>,     → val fieldName: List<...> = emptyList(),
  // Only within data class bodies for types that have defaults.

  // Build a map of enum types → { serialName: variant } for enum default injection
  const enumVariantMap = new Map<string, Map<string, string>>()
  const enumRegex = /^enum class (\w+)\(val value: String\) \{$/gm
  const variantRegex = /@SerialName\("(.+?)"\)\s+(\w+)\(".*?"\)/g
  let enumMatch: RegExpExecArray | null
  while ((enumMatch = enumRegex.exec(output)) !== null) {
    const enumName = enumMatch[1]
    const enumBlock = output.slice(enumMatch.index, output.indexOf('}', enumMatch.index + 1) + 1)
    const variants = new Map<string, string>()
    let varMatch: RegExpExecArray | null
    while ((varMatch = variantRegex.exec(enumBlock)) !== null) {
      variants.set(varMatch[1], varMatch[2]) // e.g., "case" → "Case"
    }
    enumVariantMap.set(enumName, variants)
  }

  // Build @SerialName → fieldName mapping for fields with renamed properties (e.g., hubId → hubID)
  let currentType: string | null = null
  let serialNameMap = new Map<string, string>() // serialName → fieldName for current class
  const lines = output.split('\n')
  const result: string[] = []

  // First pass: collect @SerialName mappings per class
  const classSerialNames = new Map<string, Map<string, string>>()
  let curClass: string | null = null
  let pendingSerialName: string | null = null
  for (const line of lines) {
    const classMatch = line.match(/^data class (\w+)\s*\(/)
    if (classMatch) curClass = classMatch[1]
    if (line.trim() === ')' || line.trim() === ') {') curClass = null

    if (curClass) {
      const snMatch = line.match(/@SerialName\("(.+?)"\)/)
      if (snMatch) {
        pendingSerialName = snMatch[1]
      } else if (pendingSerialName) {
        const fMatch = line.match(/^\s+val (\w+):/)
        if (fMatch) {
          getOrCreateMap(classSerialNames, curClass).set(fMatch[1], pendingSerialName) // hubID → hubId
        }
        pendingSerialName = null
      }
    }
  }

  // Second pass: inject defaults
  currentType = null
  for (const line of lines) {
    // Track which data class we're inside
    const classMatch = line.match(/^data class (\w+)\s*\(/)
    if (classMatch) {
      currentType = classMatch[1]
      serialNameMap = classSerialNames.get(currentType) ?? new Map()
    }
    if (line.trim() === ')' || line.trim() === ') {') {
      currentType = null
    }

    // Check if this line is a field declaration that needs a default
    const defaults = currentType ? defaultsMap.get(currentType) : undefined
    if (defaults) {
      // Match: val fieldName: Type,  OR  val fieldName: Type
      const fieldMatch = line.match(/^(\s+val )(\w+)(: .+?)(,?\s*)$/)
      if (fieldMatch) {
        const [, prefix, fieldName, typeDecl, suffix] = fieldMatch
        // Look up default using: fieldName, snake_case(fieldName), or @SerialName mapping
        const jsonPropName = serialNameMap.get(fieldName) // e.g., hubID → hubId
        const defaultVal = defaults.get(fieldName)
          ?? defaults.get(fieldName.replace(/[A-Z]/g, m => '_' + m.toLowerCase()))
          ?? (jsonPropName ? defaults.get(jsonPropName) : undefined)
        if (defaultVal !== undefined && !typeDecl.includes('=')) {
          // Determine the Kotlin default expression
          let kotlinDefault: string | undefined
          if (typeof defaultVal === 'boolean') {
            kotlinDefault = String(defaultVal)
          } else if (typeof defaultVal === 'number') {
            if (typeDecl.includes('Long')) {
              kotlinDefault = `${defaultVal}L`
            } else if (typeDecl.includes('Double') || typeDecl.includes('Float')) {
              kotlinDefault = Number.isInteger(defaultVal) ? `${defaultVal}.0` : String(defaultVal)
            } else {
              kotlinDefault = String(defaultVal)
            }
          } else if (typeof defaultVal === 'string') {
            const typeOnly = typeDecl.replace(/^:\s*/, '').replace(/[,\s].*$/, '')
            if (typeOnly === 'String' || typeOnly === 'String?') {
              kotlinDefault = `"${defaultVal}"`
            } else {
              // Try to map string default to enum variant
              const variants = enumVariantMap.get(typeOnly)
              if (variants?.has(defaultVal)) {
                kotlinDefault = `${typeOnly}.${variants.get(defaultVal)}`
              }
              // else: skip — can't inject default for unknown types
            }
          } else if (Array.isArray(defaultVal) && defaultVal.length === 0) {
            kotlinDefault = 'emptyList()'
          }
          if (kotlinDefault !== undefined) {
            result.push(`${prefix}${fieldName}${typeDecl} = ${kotlinDefault}${suffix}`)
            continue
          }
        }
      }
    }

    result.push(line)
  }

  // Reorder data class constructor params: fields without defaults before fields with defaults.
  // Kotlin requires non-default params to precede default params in constructors.
  return reorderKotlinConstructorParams(result.join('\n'))
}

/**
 * Reorder Kotlin data class constructor parameters so that fields without
 * default values come before fields with default values.
 *
 * Handles @SerialName annotations that precede field declarations by
 * treating annotation+field as a single logical unit.
 */
function reorderKotlinConstructorParams(output: string): string {
  const lines = output.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const classMatch = lines[i].match(/^data class \w+\s*\(/)
    if (!classMatch) {
      result.push(lines[i])
      i++
      continue
    }

    // Found a data class — collect all constructor param lines
    result.push(lines[i]) // push the "data class Foo (" line
    i++

    // Collect field entries (each entry may be annotation + field line)
    type FieldEntry = { lines: string[]; hasDefault: boolean }
    const fields: FieldEntry[] = []
    let pendingAnnotation: string | null = null

    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()

      // End of constructor
      if (trimmed === ')' || trimmed === ') {') {
        // Reorder: non-default fields first, then default fields (stable within each group)
        const noDefault = fields.filter(f => !f.hasDefault)
        const withDefault = fields.filter(f => f.hasDefault)
        const reordered = [...noDefault, ...withDefault]

        // Output reordered fields, fixing trailing commas
        for (let j = 0; j < reordered.length; j++) {
          const entry = reordered[j]
          for (let k = 0; k < entry.lines.length; k++) {
            let fieldLine = entry.lines[k]
            // Fix trailing comma on the last field's last line
            if (j === reordered.length - 1 && k === entry.lines.length - 1) {
              fieldLine = fieldLine.replace(/,(\s*)$/, '$1')
            }
            // Ensure non-last fields have trailing comma
            if (j < reordered.length - 1 && k === entry.lines.length - 1) {
              if (!fieldLine.trimEnd().endsWith(',')) {
                fieldLine = fieldLine.replace(/(\s*)$/, ',$1')
              }
            }
            result.push(fieldLine)
          }
        }
        result.push(line) // push the closing ")" or ") {"
        i++
        break
      }

      // @SerialName annotation line (precedes a val declaration)
      if (trimmed.startsWith('@SerialName(')) {
        pendingAnnotation = line
        i++
        continue
      }

      // Field declaration line
      const fieldMatch = trimmed.match(/^val \w+:/)
      if (fieldMatch) {
        const hasDefault = /=\s*.+/.test(trimmed.replace(/,\s*$/, ''))
        const entryLines = pendingAnnotation ? [pendingAnnotation, line] : [line]
        fields.push({ lines: entryLines, hasDefault })
        pendingAnnotation = null
        i++
        continue
      }

      // Blank line inside constructor — skip (reordering normalizes spacing)
      if (trimmed === '') {
        i++
        continue
      }

      // Other content inside constructor — preserve as-is
      result.push(line)
      i++
    }
  }

  return result.join('\n')
}

/**
 * In normal mode: write content to outputPath.
 * In --check mode: compare content to existing file; exit 1 if different.
 */
function writeOrCheck(outputPath: string, content: string): void {
  if (CHECK_MODE) {
    if (!existsSync(outputPath)) {
      console.error(`DRIFT DETECTED: ${outputPath} does not exist.`)
      console.error('Run: bun run codegen')
      process.exit(1)
    }
    const existing = readFileSync(outputPath, 'utf-8')
    if (existing !== content) {
      console.error(`DRIFT DETECTED: ${outputPath} is out of sync with schemas.`)
      console.error('Run: bun run codegen')
      process.exit(1)
    }
  } else {
    writeFileSync(outputPath, content)
  }
}

async function main() {
  // Build schema registry from Zod schemas
  const registry = getSchemaRegistry()
  console.log(`Found ${registry.length} schemas from Zod registry`)

  // Convert registry entries to JSON strings for quicktype
  const strippedSchemas = registry.map(({ name, jsonSchema }) => ({
    name,
    schema: JSON.stringify(stripAdditionalProperties(jsonSchema)),
  }))

  // Deduplicate identical anonymous inline objects into shared $defs
  const allSchemas = deduplicateAnonymousSchemas(strippedSchemas)

  // Build integer field maps for type post-processing
  const { perType: integerPerType, alwaysInt: integerAlwaysInt } = buildIntegerFieldMaps(allSchemas)
  const totalIntFields = [...integerPerType.values()].reduce((n, s) => n + s.size, 0)
  console.log(`Found ${totalIntFields} integer fields across ${integerPerType.size} schemas (${integerAlwaysInt.size} always-integer)`)

  // Read crypto labels
  const cryptoLabelsData = JSON.parse(readFileSync(CRYPTO_LABELS_FILE, 'utf-8'))
  const cryptoLabels = cryptoLabelsData.labels as Record<string, string>
  console.log(`Found ${Object.keys(cryptoLabels).length} crypto labels`)
  const cryptoLabelIds = readLabelRegistryIds(cryptoLabels)

  // Generate for Swift and Kotlin (TypeScript consumers use z.infer<> directly)
  const [swiftLines, kotlinLines] = await Promise.all([
    generateForLanguage('swift', allSchemas, {
      'struct-or-class': 'struct',
      'swift-5-support': 'true',
      density: 'dense',
      'access-level': 'internal',
      'acronym-style': 'pascal',
      sendable: 'true',
    }),
    generateForLanguage('kotlin', allSchemas, {
      'just-types': 'true',
      framework: 'kotlinx',
      'acronym-style': 'pascal',
      package: 'org.llamenos.protocol',
    }),
  ])

  const header = '// Auto-generated by packages/protocol/tools/codegen.ts\n// Do not edit manually.\n\n'

  // Post-process Swift: strip convenience initializer extensions, fix integer types.
  // Sendable conformance is now handled by quicktype's sendable renderer option.
  let swiftOutput = stripSwiftConvenienceExtensions(swiftLines)
  swiftOutput = fixSwiftIntegerTypes(swiftOutput, integerPerType, integerAlwaysInt)
  const swiftContent = header + swiftOutput + '\n'

  // Post-process Kotlin: inject defaults, fix integer types.
  // Package name is now handled by quicktype's package renderer option.
  let kotlinOutput = postProcessKotlin(kotlinLines.join('\n'), allSchemas)
  kotlinOutput = fixKotlinIntegerTypes(kotlinOutput, integerPerType, integerAlwaysInt)
  const kotlinContent = header + kotlinOutput + '\n'

  const tsCryptoContent = generateTypeScriptCryptoLabels(cryptoLabels)
  const swiftCryptoContent = generateSwiftCryptoLabels(cryptoLabels, cryptoLabelIds)
  const kotlinCryptoContent = generateKotlinCryptoLabels(cryptoLabels, cryptoLabelIds)
  const rustCryptoContent = generateRustCryptoLabels(cryptoLabels)

  // Write generated files (or check for drift in --check mode)
  if (!CHECK_MODE) {
    for (const dir of ['swift', 'kotlin', 'rust']) {
      mkdirSync(join(GENERATED_DIR, dir), { recursive: true })
    }
  }

  // TypeScript crypto labels go to packages/shared/ (not gitignored — consumed directly by TS imports)
  const TS_CRYPTO_LABELS_OUTPUT = resolve(__dirname, '../../shared/crypto-labels.ts')
  writeOrCheck(TS_CRYPTO_LABELS_OUTPUT, tsCryptoContent)

  writeOrCheck(join(GENERATED_DIR, 'swift', 'Types.swift'), swiftContent)
  writeOrCheck(join(GENERATED_DIR, 'swift', 'CryptoLabels.swift'), swiftCryptoContent)
  writeOrCheck(join(GENERATED_DIR, 'kotlin', 'Types.kt'), kotlinContent)
  writeOrCheck(join(GENERATED_DIR, 'kotlin', 'CryptoLabels.kt'), kotlinCryptoContent)
  writeOrCheck(join(GENERATED_DIR, 'rust', 'crypto_labels.rs'), rustCryptoContent)

  if (CHECK_MODE) {
    console.log('Check passed: generated files are up-to-date.')
  } else {
    console.log('Generated:')
    console.log('  packages/shared/crypto-labels.ts')
    console.log('  swift/Types.swift + CryptoLabels.swift')
    console.log('  kotlin/Types.kt + CryptoLabels.kt')
    console.log('  rust/crypto_labels.rs')
  }
}

main()
