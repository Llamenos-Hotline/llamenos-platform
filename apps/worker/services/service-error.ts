/**
 * The error every service method throws for a known failure condition, and its wire body.
 */
import { HUB_NOT_FOUND_CODE, type ErrorResponse } from '@protocol/schemas/common'

/** Thrown by service methods for known error conditions */
export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Machine-readable code clients branch on (`errorResponseSchema.code`); absent for plain errors. */
    public readonly code?: ErrorResponse['code'],
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

/**
 * The hub row looked up by its id is not there (#2872). The ONLY error that
 * carries `HUB_NOT_FOUND`, the code a client forgets a hub on — throw it only
 * from a lookup of the hub itself. An update that matched no rows, a missing
 * resource inside a hub, and every permission refusal are plain `ServiceError`s.
 */
export class HubNotFoundError extends ServiceError {
  constructor() {
    super(404, 'Hub not found', HUB_NOT_FOUND_CODE)
    this.name = 'HubNotFoundError'
  }
}

/** The wire body for a `ServiceError`: its message, plus its code when it has one. */
export function serviceErrorBody(err: ServiceError): ErrorResponse {
  return err.code === undefined ? { error: err.message } : { error: err.message, code: err.code }
}
