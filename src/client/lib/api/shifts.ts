import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, activeHubPath } from './client'
import type { CreateShiftBody, FallbackGroup } from '@protocol/schemas/shifts'
import type { Shift, ShiftStatus } from '@protocol/schemas'

export type { Shift, ShiftStatus }

// --- Shift Status (all users) ---

export async function getMyShiftStatus() {
  return request<ShiftStatus>(activeHubPath('/shifts/my-status'))
}

// --- Shifts (admin only) ---

export async function listShifts() {
  return request<{ shifts: Shift[] }>(activeHubPath('/shifts'))
}

export async function createShift(data: CreateShiftBody) {
  return request<Shift>(activeHubPath('/shifts'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateShift(id: string, data: Partial<Shift>) {
  return request<Shift>(activeHubPath(`/shifts/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/** Delete a shift. Requires the admin's confirmation of exactly this shift (#2575). */
export async function deleteShift(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'shift', id)
  return request<{ ok: true }>(activeHubPath(`/shifts/${id}`), { method: 'DELETE' })
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
  return request<{ ok: true }>(activeHubPath('/shifts/clock-in'), { method: 'POST' })
}

export async function clockOut() {
  return request<{ ok: true }>(activeHubPath('/shifts/clock-out'), { method: 'POST' })
}

export async function sendHeartbeat() {
  return request<{ ok: true }>(activeHubPath('/shifts/heartbeat'), { method: 'POST' })
}

export async function listActiveShifts() {
  return request<{ activeShifts: Array<{ pubkey: string; hubId: string; startedAt: string; lastHeartbeat: string }> }>(activeHubPath('/shifts/active'))
}

// --- Shift Overrides ---

export async function listShiftOverrides(from: string, to: string) {
  return request<{ overrides: Array<{ id: string; hubId: string; shiftId: string | null; date: string; type: string; userPubkeys: string[] | null; encryptedNote: string | null; createdBy: string; createdAt: string }> }>(
    activeHubPath(`/shifts/overrides?from=${from}&to=${to}`)
  )
}

export async function createShiftOverride(data: { id: string; shiftId?: string | null; date: string; type: 'cancel' | 'substitute'; userPubkeys?: string[] | null; encryptedNote?: string | null }) {
  return request<{ id: string; hubId: string; shiftId: string | null; date: string; type: string; userPubkeys: string[] | null; encryptedNote: string | null; createdBy: string; createdAt: string }>(activeHubPath('/shifts/overrides'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** Delete a shift override. Requires the admin's confirmation of exactly this override (#2575). */
export async function deleteShiftOverride(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'shiftOverride', id)
  return request<{ ok: true }>(activeHubPath(`/shifts/overrides/${id}`), { method: 'DELETE' })
}

// --- Availability Blocks ---

export async function listAvailabilityBlocks(from: string, to: string) {
  return request<{ blocks: Array<{ id: string; hubId: string; userPubkey: string; startDate: string; endDate: string; encryptedReason: string | null; createdAt: string }> }>(
    activeHubPath(`/shifts/availability?from=${from}&to=${to}`)
  )
}

export async function listMyAvailabilityBlocks() {
  return request<{ blocks: Array<{ id: string; hubId: string; userPubkey: string; startDate: string; endDate: string; encryptedReason: string | null; createdAt: string }> }>(activeHubPath('/shifts/availability/my'))
}

export async function createAvailabilityBlock(data: { id: string; startDate: string; endDate: string; encryptedReason?: string | null }) {
  return request<{ id: string; hubId: string; userPubkey: string; startDate: string; endDate: string; encryptedReason: string | null; createdAt: string }>(activeHubPath('/shifts/availability'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function deleteAvailabilityBlock(id: string) {
  return request<{ ok: true }>(activeHubPath(`/shifts/availability/${id}`), { method: 'DELETE' })
}

// --- Shift Requests ---

export async function listShiftRequests() {
  return request<{ requests: Array<{ id: string; hubId: string; shiftId: string; userPubkey: string; type: string; status: string; reviewedBy: string | null; reviewedAt: string | null; createdAt: string }> }>(activeHubPath('/shifts/requests'))
}

export async function createShiftRequest(data: { shiftId: string; type: 'join' | 'leave' }) {
  return request<{ id: string; hubId: string; shiftId: string; userPubkey: string; type: string; status: string; reviewedBy: string | null; reviewedAt: string | null; createdAt: string }>(activeHubPath('/shifts/requests'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function approveShiftRequest(id: string) {
  return request<{ id: string; hubId: string; shiftId: string; userPubkey: string; type: string; status: string; reviewedBy: string | null; reviewedAt: string | null; createdAt: string }>(activeHubPath(`/shifts/requests/${id}/approve`), {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  })
}

export async function rejectShiftRequest(id: string) {
  return request<{ id: string; hubId: string; shiftId: string; userPubkey: string; type: string; status: string; reviewedBy: string | null; reviewedAt: string | null; createdAt: string }>(activeHubPath(`/shifts/requests/${id}/reject`), {
    method: 'POST',
    body: JSON.stringify({ status: 'denied' }),
  })
}
