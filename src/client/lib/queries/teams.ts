import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  listTeamMembers,
  addTeamMembers,
  removeTeamMember,
  listTeamContacts,
  assignTeamContacts,
  unassignTeamContact,
} from '@/lib/api'
import type { TeamResponse, TeamMemberResponse, ContactTeamAssignmentResponse } from '@protocol/schemas'
import { encryptForHub, decryptFromHub } from '@/lib/hub-key-manager'
import { LABEL_TEAM_ENCRYPT } from '@shared/crypto-labels'

export const teamKeys = {
  all: ['teams'] as const,
  list: () => [...teamKeys.all, 'list'] as const,
  detail: (id: string) => [...teamKeys.all, 'detail', id] as const,
  members: (teamId: string) => [...teamKeys.all, 'members', teamId] as const,
  contacts: (teamId: string) => [...teamKeys.all, 'contacts', teamId] as const,
}

// ---------------------------------------------------------------------------
// Decrypted types
// ---------------------------------------------------------------------------

export interface DecryptedTeam extends Omit<TeamResponse, 'encryptedName' | 'encryptedDescription'> {
  name: string
  description: string | null
  encryptedName: string
  encryptedDescription: string | null
}

async function decryptTeam(team: TeamResponse): Promise<DecryptedTeam> {
  const [name, description] = await Promise.all([
    decryptFromHub(team.encryptedName, LABEL_TEAM_ENCRYPT),
    team.encryptedDescription
      ? decryptFromHub(team.encryptedDescription, LABEL_TEAM_ENCRYPT)
      : Promise.resolve(null),
  ])
  return {
    ...team,
    name: name ?? team.encryptedName,
    description: description,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useTeams() {
  return useQuery({
    queryKey: teamKeys.list(),
    queryFn: async () => {
      const { teams } = await listTeams()
      return Promise.all(teams.map(decryptTeam))
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useTeamMembers(teamId: string) {
  return useQuery({
    queryKey: teamKeys.members(teamId),
    queryFn: async (): Promise<TeamMemberResponse[]> => {
      const { members } = await listTeamMembers(teamId)
      return members
    },
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
  })
}

export function useTeamContacts(teamId: string) {
  return useQuery({
    queryKey: teamKeys.contacts(teamId),
    queryFn: async (): Promise<ContactTeamAssignmentResponse[]> => {
      const { assignments } = await listTeamContacts(teamId)
      return assignments
    },
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateTeam() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      const encryptedName = await encryptForHub(name, LABEL_TEAM_ENCRYPT)
      const encryptedDescription = description
        ? await encryptForHub(description, LABEL_TEAM_ENCRYPT)
        : undefined
      return createTeam({
        id: crypto.randomUUID(),
        encryptedName,
        encryptedDescription,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list() })
    },
  })
}

export function useUpdateTeam() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      name,
      description,
    }: {
      id: string
      name?: string
      description?: string | null
    }) => {
      const encryptedName = name !== undefined
        ? await encryptForHub(name, LABEL_TEAM_ENCRYPT)
        : undefined
      const encryptedDescription =
        description === null
          ? null
          : description !== undefined
            ? await encryptForHub(description, LABEL_TEAM_ENCRYPT)
            : undefined
      return updateTeam(id, { encryptedName, encryptedDescription })
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list() })
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(id) })
    },
  })
}

export function useDeleteTeam() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteTeam,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.all })
    },
  })
}

export function useAddTeamMembers() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ teamId, pubkeys }: { teamId: string; pubkeys: string[] }) =>
      addTeamMembers(teamId, pubkeys),
    onSuccess: (_data, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) })
      queryClient.invalidateQueries({ queryKey: teamKeys.list() })
    },
  })
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ teamId, userPubkey }: { teamId: string; userPubkey: string }) =>
      removeTeamMember(teamId, userPubkey),
    onSuccess: (_data, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) })
      queryClient.invalidateQueries({ queryKey: teamKeys.list() })
    },
  })
}

export function useAssignTeamContacts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ teamId, contactIds }: { teamId: string; contactIds: string[] }) =>
      assignTeamContacts(teamId, contactIds),
    onSuccess: (_data, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.contacts(teamId) })
      queryClient.invalidateQueries({ queryKey: teamKeys.list() })
    },
  })
}

export function useUnassignTeamContact() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ teamId, contactId }: { teamId: string; contactId: string }) =>
      unassignTeamContact(teamId, contactId),
    onSuccess: (_data, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.contacts(teamId) })
      queryClient.invalidateQueries({ queryKey: teamKeys.list() })
    },
  })
}
