/**
 * The response of `POST /api/test-seed` — one declaration, two consumers.
 *
 * The route builds its response through {@link SeedOutcome} and the Playwright
 * helper (`tests/api-helpers.ts`) takes its type from {@link seedResultSchema}.
 * The Android client (`TestApiClient.SeedResult`) mirrors this shape by hand;
 * `dev-test-seed-result.test.ts` and `SeedResultTest.kt` parse the same
 * literal wire JSON so a rename on either side turns a test red.
 *
 * Why it exists (#3088): the route used to return `ok: true` unconditionally and
 * report partial failure in a `warnings` list the Android client never read (it
 * read `errors`). A seed that dropped a step passed, and #3082/#3083 cost hours
 * because nothing named the step that had not happened.
 *
 * Semantics:
 *  - a **step** is one thing the spec asked for (a member, an entity type, a record…);
 *  - a step either happened (`ok`) or did not (`failed`) — a failed step is never a warning;
 *  - a **warning** is a note about a step that DID happen (e.g. an entity type was reused);
 *  - `ok` is true only when no step failed.
 */
import { z } from 'zod'

export const seedStepSchema = z.object({
  step: z.string(),
  outcome: z.enum(['ok', 'failed']),
  /** Present only when `outcome` is `failed`. */
  error: z.string().optional(),
})

export const seedResultSchema = z.object({
  ok: z.boolean(),
  hubId: z.string(),
  entityTypes: z.array(z.object({ id: z.string(), name: z.string(), category: z.string() })),
  records: z.array(z.object({ id: z.string(), entityTypeId: z.string(), caseNumber: z.string().optional() })),
  reportTypes: z.array(z.object({ id: z.string(), name: z.string() })),
  triageReports: z.array(z.object({ id: z.string() })),
  shifts: z.array(z.object({ id: z.string() })),
  members: z.array(z.object({ pubkey: z.string() })),
  contacts: z.array(z.object({ id: z.string() })),
  /** Every step the spec asked for, in order, with what happened to it. */
  steps: z.array(seedStepSchema),
  /** `"<step>: <error>"` for each failed step; empty exactly when `ok`. */
  failures: z.array(z.string()),
  /** Notes about steps that happened; never a substitute for a failure. */
  warnings: z.array(z.string()),
})

export type SeedStep = z.infer<typeof seedStepSchema>
export type SeedResultBody = z.infer<typeof seedResultSchema>

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class SeedOutcome {
  readonly steps: SeedStep[] = []
  readonly warnings: string[] = []

  succeed(step: string): void {
    this.steps.push({ step, outcome: 'ok' })
  }

  fail(step: string, error: unknown): void {
    this.steps.push({ step, outcome: 'failed', error: typeof error === 'string' ? error : errorMessage(error) })
  }

  warn(note: string): void {
    this.warnings.push(note)
  }

  /** Run one step: record `ok` and return its value, or record `failed` and return `undefined`. */
  async run<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await fn()
      this.succeed(step)
      return value
    } catch (e) {
      this.fail(step, e)
      return undefined
    }
  }

  get failures(): string[] {
    return this.steps.filter((s) => s.outcome === 'failed').map((s) => `${s.step}: ${s.error}`)
  }

  get ok(): boolean {
    return this.failures.length === 0
  }
}
