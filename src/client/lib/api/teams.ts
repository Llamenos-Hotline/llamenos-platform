import { request, hp } from './client'
import type { TeamResponse, ContactTeamAssignmentListResponse, CreateTeamBody, OkResponse, TeamListResponse, TeamMemberListResponse, UpdateTeamBody } from '@protocol/schemas'

// ---------------------------------------------------------------------------
// Teams API
// ---------------------------------------------------------------------------

export async function listTeams() {
  return request<TeamListResponse>(hp('/teams'))
}

export async function createTeam(body: CreateTeamBody): Promise<TeamResponse> {
  return request<TeamResponse>(hp('/teams'), { method: 'POST', body: JSON.stringify(body) })
}

export async function getTeam(teamId: string): Promise<TeamResponse> {
  return request<TeamResponse>(hp(`/teams/${teamId}`))
}

export async function updateTeam(teamId: string, body: UpdateTeamBody): Promise<TeamResponse> {
  return request<TeamResponse>(hp(`/teams/${teamId}`), { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteTeam(teamId: string) {
  return request<OkResponse>(hp(`/teams/${teamId}`), { method: 'DELETE' })
}

export async function listTeamMembers(teamId: string) {
  return request<TeamMemberListResponse>(hp(`/teams/${teamId}/members`))
}

export async function addTeamMembers(teamId: string, pubkeys: string[]) {
  return request<OkResponse>(hp(`/teams/${teamId}/members`), { method: 'POST', body: JSON.stringify({ pubkeys }) })
}

export async function removeTeamMember(teamId: string, userPubkey: string) {
  return request<OkResponse>(hp(`/teams/${teamId}/members/${encodeURIComponent(userPubkey)}`), { method: 'DELETE' })
}

export async function listTeamContacts(teamId: string) {
  return request<ContactTeamAssignmentListResponse>(hp(`/teams/${teamId}/contacts`))
}

export async function assignTeamContacts(teamId: string, contactIds: string[]) {
  return request<OkResponse>(hp(`/teams/${teamId}/contacts`), { method: 'POST', body: JSON.stringify({ contactIds }) })
}

export async function unassignTeamContact(teamId: string, contactId: string) {
  return request<OkResponse>(hp(`/teams/${teamId}/contacts/${contactId}`), { method: 'DELETE' })
}
