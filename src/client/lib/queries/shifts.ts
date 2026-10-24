import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
  getFallbackGroup,
  setFallbackGroup,
  listRingGroups,
  getRingGroup,
  createRingGroup,
  updateRingGroup,
  deleteRingGroup,
  addRingGroupMembers,
  removeRingGroupMembers,
  clockIn,
  clockOut,
  listActiveShifts,
  listShiftOverrides,
  createShiftOverride,
  deleteShiftOverride,
  listMyAvailabilityBlocks,
  createAvailabilityBlock,
  deleteAvailabilityBlock,
  listShiftRequests,
  createShiftRequest,
  approveShiftRequest,
  rejectShiftRequest,
  getMyShiftStatus,
  type Shift,
} from '@/lib/api'
import { z } from 'zod'
import { useConfig } from '@/lib/config'
import { createShiftBodySchema } from '@protocol/schemas/shifts'

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const shiftKeys = {
  all: ['shifts'] as const,
  list: () => [...shiftKeys.all, 'list'] as const,
  fallback: () => [...shiftKeys.all, 'fallback'] as const,
  /** Prefix of every hub's my-status entry — what clock-in/out invalidate. */
  myStatus: () => [...shiftKeys.all, 'my-status'] as const,
  /** my-status is hub-scoped (`/hubs/<id>/shifts/my-status`), so it is cached per hub. */
  myStatusFor: (hubId: string) => [...shiftKeys.myStatus(), hubId] as const,
  active: () => [...shiftKeys.all, 'active'] as const,
  ringGroups: {
    all: ['ring-groups'] as const,
    list: () => [...shiftKeys.ringGroups.all, 'list'] as const,
    detail: (id: string) => [...shiftKeys.ringGroups.all, 'detail', id] as const,
  },
  overrides: (from: string, to: string) => [...shiftKeys.all, 'overrides', from, to] as const,
  myAvailability: () => [...shiftKeys.all, 'availability', 'my'] as const,
  requests: () => [...shiftKeys.all, 'requests'] as const,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useShifts() {
  return useQuery({
    queryKey: shiftKeys.list(),
    queryFn: async () => {
      const { shifts } = await listShifts()
      return shifts
    },
    staleTime: 2 * 60 * 1000,
  })
}

export function useFallbackGroup() {
  return useQuery({
    queryKey: shiftKeys.fallback(),
    queryFn: async () => {
      const { userPubkeys } = await getFallbackGroup()
      return userPubkeys
    },
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * The current user's shift state in the ACTIVE hub: scheduled now, clocked in,
 * next shift. Keyed on the hub so a hub switch never shows another hub's state, and
 * disabled until a hub has resolved (the first poll used to win the race against hub
 * resolution and report an on-shift volunteer as "Off Shift" — #1708).
 */
export function useMyShiftStatus() {
  const { currentHubId } = useConfig()
  return useQuery({
    queryKey: shiftKeys.myStatusFor(currentHubId ?? ''),
    queryFn: getMyShiftStatus,
    enabled: !!currentHubId,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  })
}

export function useActiveShifts() {
  return useQuery({
    queryKey: shiftKeys.active(),
    queryFn: async () => {
      const { activeShifts } = await listActiveShifts()
      return activeShifts
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  })
}

export function useRingGroups() {
  return useQuery({
    queryKey: shiftKeys.ringGroups.list(),
    queryFn: async () => {
      const { ringGroups } = await listRingGroups()
      return ringGroups
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useRingGroupDetail(id: string) {
  return useQuery({
    queryKey: shiftKeys.ringGroups.detail(id),
    queryFn: () => getRingGroup(id),
    enabled: !!id,
    staleTime: 2 * 60 * 1000,
  })
}

export function useShiftOverrides(from: string, to: string) {
  return useQuery({
    queryKey: shiftKeys.overrides(from, to),
    queryFn: async () => {
      const { overrides } = await listShiftOverrides(from, to)
      return overrides
    },
    staleTime: 2 * 60 * 1000,
  })
}

export function useMyAvailabilityBlocks() {
  return useQuery({
    queryKey: shiftKeys.myAvailability(),
    queryFn: async () => {
      const { blocks } = await listMyAvailabilityBlocks()
      return blocks
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useShiftRequests() {
  return useQuery({
    queryKey: shiftKeys.requests(),
    queryFn: async () => {
      const { requests } = await listShiftRequests()
      return requests
    },
    staleTime: 30 * 1000,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateShift() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: z.infer<typeof createShiftBodySchema>) => createShift(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.list() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
    },
  })
}

export function useUpdateShift() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Shift> }) => updateShift(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.list() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
    },
  })
}

export function useDeleteShift() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteShift(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.list() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
    },
  })
}

export function useSetFallbackGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (pubkeys: string[]) => setFallbackGroup(pubkeys),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.fallback() })
    },
  })
}

export function useCreateRingGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: string; encryptedName: string }) => createRingGroup(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.list() })
    },
  })
}

export function useUpdateRingGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { encryptedName: string } }) =>
      updateRingGroup(id, data),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.list() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.detail(id) })
    },
  })
}

export function useDeleteRingGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteRingGroup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.all })
    },
  })
}

export function useAddRingGroupMembers() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, pubkeys }: { id: string; pubkeys: string[] }) =>
      addRingGroupMembers(id, pubkeys),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.detail(id) })
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.list() })
    },
  })
}

export function useRemoveRingGroupMembers() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, pubkeys }: { id: string; pubkeys: string[] }) =>
      removeRingGroupMembers(id, pubkeys),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.detail(id) })
      queryClient.invalidateQueries({ queryKey: shiftKeys.ringGroups.list() })
    },
  })
}

export function useClockIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: clockIn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.active() })
    },
  })
}

export function useClockOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: clockOut,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.active() })
    },
  })
}

export function useCreateShiftOverride() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: string; shiftId?: string | null; date: string; type: 'cancel' | 'substitute'; userPubkeys?: string[] | null; encryptedNote?: string | null }) =>
      createShiftOverride(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.all })
    },
  })
}

export function useDeleteShiftOverride() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteShiftOverride(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.all })
    },
  })
}

export function useCreateAvailabilityBlock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: string; startDate: string; endDate: string; encryptedReason?: string | null }) =>
      createAvailabilityBlock(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.myAvailability() })
    },
  })
}

export function useDeleteAvailabilityBlock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteAvailabilityBlock(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.myAvailability() })
    },
  })
}

export function useCreateShiftRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { shiftId: string; type: 'join' | 'leave' }) => createShiftRequest(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.requests() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.list() })
    },
  })
}

export function useApproveShiftRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => approveShiftRequest(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.requests() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.list() })
    },
  })
}

export function useRejectShiftRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => rejectShiftRequest(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.requests() })
    },
  })
}
