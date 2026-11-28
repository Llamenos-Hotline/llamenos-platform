/**
 * Server-side blind index query parsing and matching.
 *
 * Parses URL query parameters containing blind index hashes and matches
 * them against stored index values on records. The server never sees
 * plaintext values — only opaque hash tokens computed by the client.
 */

/**
 * Parse blind index filter parameters from URL search params.
 *
 * Convention: parameters ending in "Hash" or containing "_day", "_week",
 * "_month" are blind index filters. Multiple values can be comma-separated
 * for OR queries (e.g., createdMonth=abc123,def456 matches March OR April).
 *
 * @example
 * ?nameHash=abc123&tagHash=def456&createdMonth=ghi789,jkl012
 */
export function parseBlindIndexFilters(
  searchParams: URLSearchParams,
): Map<string, string[]> {
  const filters = new Map<string, string[]>()

  for (const [key, value] of searchParams) {
    if (
      key.endsWith('Hash') ||
      key.startsWith('field_') ||
      key.endsWith('_day') ||
      key.endsWith('_week') ||
      key.endsWith('_month') ||
      key === 'nameHash'
    ) {
      filters.set(
        key,
        value.split(',').map(v => v.trim()).filter(Boolean),
      )
    }
  }

  return filters
}

/**
 * Check if a record's stored blind indexes match all provided filters.
 *
 * All filters must match (AND logic). Within a single filter, any value
 * can match (OR logic for comma-separated values).
 *
 * @param recordIndexes - The blind index values stored on the record
 * @param filters - Parsed filters from parseBlindIndexFilters()
 * @returns true if all filters match
 */
export function matchesBlindIndexFilters(
  recordIndexes: Record<string, string | string[]>,
  filters: Map<string, string[]>,
): boolean {
  for (const [filterKey, filterValues] of filters) {
    const recordValue = recordIndexes[filterKey]
    if (recordValue === undefined || recordValue === null) return false

    if (Array.isArray(recordValue)) {
      // Trigram/multi-value index: any filter value must match any record token
      if (!filterValues.some(fv => recordValue.includes(fv))) return false
    } else {
      // Exact index: any filter value must match the record's single value
      if (!filterValues.includes(recordValue)) return false
    }
  }

  return true
}
