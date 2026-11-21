/**
 * The request validator every route mounts (#2710).
 *
 * `hono-openapi`'s `validator()` answers a request that fails its schema with
 * its library default:
 *
 *     400 { "success": false, "data": <the request, echoed>, "error": Issue[] }
 *
 * Every route declares its 400 as `errorResponseSchema` — `error` is a STRING,
 * with machine-readable `details` beside it — and the Swift `Codable` and
 * Kotlin `@Serializable` error types are generated from that schema. So a
 * malformed request made every mobile client's error decode throw on `error`
 * (an array where a string is declared), and the declared-response check could
 * only excuse it as a ledgered "cause" rather than fix it. The default also
 * echoed the request body back — credentials included, for the telephony
 * provider routes — which no error answer should do.
 *
 * This is the same `validator()` with one default hook that answers in the
 * declared shape. Import it from here, never from `hono-openapi`
 * (`eslint.config.js` enforces that), so the shape is decided in one place.
 * A route that passes a hook of its own keeps it.
 */
import type { Context } from 'hono'
import { validator as openApiValidator } from 'hono-openapi'
import type { ErrorResponse } from '@protocol/schemas/common'

/** The message every request-validation failure carries; `details` says what was wrong. */
export const VALIDATION_FAILED_MESSAGE = 'Validation failed'

interface ValidationIssue {
  message: string
  path?: readonly (PropertyKey | { key: PropertyKey })[]
}

type ValidationResult =
  | { success: true }
  | { success: false; error: readonly ValidationIssue[]; target: string }

function fieldOf(issue: ValidationIssue, target: string): string {
  const path = (issue.path ?? []).map(seg => String(typeof seg === 'object' ? seg.key : seg)).join('.')
  // A failure of the target as a whole (a missing body, a cross-field refine)
  // has no path; name the part of the request it was.
  return path === '' ? target : path
}

/** The declared 400 body for a failed validation — never the request itself. */
export function validationFailedBody(error: readonly ValidationIssue[], target: string): ErrorResponse {
  return {
    error: VALIDATION_FAILED_MESSAGE,
    details: error.map(issue => ({ field: fieldOf(issue, target), message: issue.message })),
  }
}

function answerValidationFailure(result: ValidationResult, c: Context): Response | undefined {
  if (result.success) return undefined
  return c.json(validationFailedBody(result.error, result.target), 400)
}

export const validator: typeof openApiValidator = ((target, schema, hook, options) =>
  openApiValidator(target, schema, hook ?? answerValidationFailure, options)) as typeof openApiValidator
