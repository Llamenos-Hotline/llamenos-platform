/**
 * Every incident category the protocol declares has a label on every client.
 *
 * The desktop table is a `Record<IncidentCategory, …>`, so tsc catches a missing
 * entry there. Swift and Kotlin match on the wire string with a generic-title
 * default, so a category appended to the schema compiles everywhere and silently
 * renders as "Active incidents" on mobile (#2330 appended `routing` and
 * `provider-auth` exactly that way). This pins the two mobile tables to the schema.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { incidentCategorySchema } from '@protocol/schemas/incidents'

const root = resolve(__dirname, '../../../..')
const ios = readFileSync(resolve(root, 'apps/ios/Sources/Views/Incidents/IncidentViews.swift'), 'utf8')
const android = readFileSync(
  resolve(root, 'apps/android/app/src/main/java/org/llamenos/hotline/ui/incidents/IncidentBanner.kt'),
  'utf8',
)

describe('incident category labels', () => {
  it.each(incidentCategorySchema.options)('%s is labelled on iOS and Android', (category) => {
    expect(ios).toContain(`case "${category}":`)
    expect(android).toContain(`"${category}" ->`)
  })
})
