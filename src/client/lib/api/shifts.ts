import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, activeHubPath, hubPath } from './client'
import type { CreateShiftBody, FallbackGroup } from '@protocol/schemas/shifts'
import type { Shift, ShiftStatus, CreateShiftJoinRequestBody, OkResponse, ShiftJoinRequestListResponse, ShiftJoinRequestResponse, ShiftListResponse, UpdateShiftBody } from '@protocol/schemas'
import type { CreateShiftOverrideBody, ShiftOverride, ShiftOverrideListResponse } from '@protocol/schemas/shift-override'
import type { AvailabilityBlock, AvailabilityBlockListResponse, CreateAvailabilityBlockBody } from '@protocol/schemas/shift-availability'

export type { Shift, ShiftStatus }

// --- Shift Status (all users) ---

export async function getMyShiftStatus() {
  return request<ShiftStatus>(activeHubPath('/shifts/my-status'))
}

/**
 * The user's shift state in an explicit hub, whichever hub the UI is showing. A
 * clock-in is per hub, so anything that must act on every clock-in the user holds
 * (the heartbeat sender) reads each member hub rather than only the active one
 * (multi-hub axiom).
 */
export async function getMyShiftStatusIn(hubId: string) {
  return request<ShiftStatus>(hubPath(hubId, '/shifts/my-status'))
}

// --- Shifts (admin only) ---

export async function listShifts() {
  return request<ShiftListResponse>(activeHubPath('/shifts'))
}

export async function createShift(data: CreateShiftBody) {
  return request<Shift>(activeHubPath('/shifts'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateShift(id: string, data: UpdateShiftBody) {
  return request<Shift>(activeHubPath(`/shifts/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/** Delete a shift. Requires the admin's confirmation of exactly this shift (#2575). */
export async function deleteShift(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'shift', id)
  return request<OkResponse>(activeHubPath(`/shifts/${id}`), { method: 'DELETE' })
}

export async function getFallbackGroup() {
  return request<FallbackGroup>(activeHubPath('/shifts/fallback'))
}

export async function setFallbackGroup(volunteers: string[]) {
  return request<FallbackGroup>(activeHubPath('/shifts/fallback'), {
    method: 'PUT',
    body: JSON.stringify({ userPubkeys: volunteers }),
  })
}

// --- Shift Clock-in / Clock-out / Heartbeat ---

export async function clockIn() {
  return request<OkResponse>(activeHubPath('/shifts/clock-in'), { method: 'POST' })
}

export async function clockOut() {
  return request<OkResponse>(activeHubPath('/shifts/clock-out'), { method: 'POST' })
}

/**
 * Tell `hubId` this clocked-in client is still here. Takes the hub explicitly:
 * a clock-in is per hub and the user may be clocked into several at once, so the
 * heartbeat must reach each of them whichever hub the UI is showing (multi-hub
 * axiom). Answers 404 when the user is not (or is no longer) clocked in there.
 */
export async function sendHeartbeat(hubId: string) {
  return request<OkResponse>(hubPath(hubId, '/shifts/heartbeat'), { method: 'POST' })
}

export async function listActiveShifts() {
  return request<{ activeShifts: Array<{ pubkey: string; hubId: string; startedAt: string; lastHeartbeat: string }> }>(activeHubPath('/shifts/active'))
}

// --- Shift Overrides ---

export async function listShiftOverrides(from: string, to: string) {
  return request<ShiftOverrideListResponse>(
    activeHubPath(`/shifts/overrides?from=${from}&to=${to}`)
  )
}

export async function createShiftOverride(data: CreateShiftOverrideBody) {
  return request<ShiftOverride>(activeHubPath('/shifts/overrides'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** Delete a shift override. Requires the admin's confirmation of exactly this override (#2575). */
export async function deleteShiftOverride(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'shiftOverride', id)
  return request<OkResponse>(activeHubPath(`/shifts/overrides/${id}`), { method: 'DELETE' })
}

// --- Availability Blocks ---

export async function listAvailabilityBlocks(from: string, to: string) {
  return request<AvailabilityBlockListResponse>(
    activeHubPath(`/shifts/availability?from=${from}&to=${to}`)
  )
}

export async function listMyAvailabilityBlocks() {
  return request<AvailabilityBlockListResponse>(activeHubPath('/shifts/availability/my'))
}

export async function createAvailabilityBlock(data: CreateAvailabilityBlockBody) {
  return request<AvailabilityBlock>(activeHubPath('/shifts/availability'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function deleteAvailabilityBlock(id: string) {
  return request<OkResponse>(activeHubPath(`/shifts/availability/${id}`), { method: 'DELETE' })
}

// --- Shift Requests ---

export async function listShiftRequests() {
  return request<ShiftJoinRequestListResponse>(activeHubPath('/shifts/requests'))
}

export async function createShiftRequest(data: CreateShiftJoinRequestBody) {
  return request<ShiftJoinRequestResponse>(activeHubPath('/shifts/requests'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function approveShiftRequest(id: string) {
  return request<ShiftJoinRequestResponse>(activeHubPath(`/shifts/requests/${id}/approve`), {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  })
}

export async function rejectShiftRequest(id: string) {
  return request<ShiftJoinRequestResponse>(activeHubPath(`/shifts/requests/${id}/reject`), {
    method: 'POST',
    body: JSON.stringify({ status: 'denied' }),
  })
}
