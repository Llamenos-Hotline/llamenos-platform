import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types/infra'
import { requirePermission } from '../middleware/permission-guard'
import {
  teamListResponseSchema,
  teamResponseSchema,
  teamMemberListResponseSchema,
  contactTeamAssignmentListResponseSchema,
  createTeamBodySchema,
  updateTeamBodySchema,
  addTeamMembersBodySchema,
  assignTeamContactsBodySchema,
} from '@protocol/schemas/team'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'

const teams = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// GET /teams — list all teams for hub
// ---------------------------------------------------------------------------

teams.get('/',
  describeRoute({
    tags: ['Teams'],
    summary: 'List hub teams',
    responses: {
      200: {
        description: 'Team list',
        content: { 'application/json': { schema: resolver(teamListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('teams:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const rows = await services.teams.listTeams(hubId)
    return c.json({
      teams: rows.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    })
  },
)

// ---------------------------------------------------------------------------
// POST /teams — create team
// ---------------------------------------------------------------------------

teams.post('/',
  describeRoute({
    tags: ['Teams'],
    summary: 'Create a team',
    responses: {
      200: {
        description: 'Created team',
        content: { 'application/json': { schema: resolver(teamResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('teams:manage'),
  validator('json', createTeamBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')

    const team = await services.teams.createTeam({
      id: body.id,
      hubId,
      encryptedName: body.encryptedName,
      encryptedDescription: body.encryptedDescription,
      createdBy: pubkey,
    })

    await audit(services.audit, 'teamCreated', pubkey, { teamId: team.id }, undefined, hubId)

    return c.json({
      ...team,
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
    })
  },
)

// ---------------------------------------------------------------------------
// GET /teams/:teamId — get single team
// ---------------------------------------------------------------------------

teams.get('/:teamId',
  describeRoute({
    tags: ['Teams'],
    summary: 'Get team by ID',
    responses: {
      200: {
        description: 'Team detail',
        content: { 'application/json': { schema: resolver(teamResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const teamId = c.req.param('teamId')

    const team = await services.teams.getTeam(teamId, hubId)
    return c.json({
      ...team,
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
    })
  },
)

// ---------------------------------------------------------------------------
// PATCH /teams/:teamId — update team
// ---------------------------------------------------------------------------

teams.patch('/:teamId',
  describeRoute({
    tags: ['Teams'],
    summary: 'Update team',
    responses: {
      200: {
        description: 'Updated team',
        content: { 'application/json': { schema: resolver(teamResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:manage'),
  validator('json', updateTeamBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const teamId = c.req.param('teamId')
    const body = c.req.valid('json')

    const pubkey = c.get('pubkey')
    const team = await services.teams.updateTeam(teamId, hubId, body)
    await audit(services.audit, 'teamUpdated', pubkey, { teamId }, undefined, hubId)
    return c.json({
      ...team,
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
    })
  },
)

// ---------------------------------------------------------------------------
// DELETE /teams/:teamId — delete team
// ---------------------------------------------------------------------------

teams.delete('/:teamId',
  describeRoute({
    tags: ['Teams'],
    summary: 'Delete team',
    responses: {
      200: {
        description: 'Deleted',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const teamId = c.req.param('teamId')

    await services.teams.deleteTeam(teamId, hubId)
    await audit(services.audit, 'teamDeleted', pubkey, { teamId }, undefined, hubId)
    return c.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// GET /teams/:teamId/members — list members
// ---------------------------------------------------------------------------

teams.get('/:teamId/members',
  describeRoute({
    tags: ['Teams'],
    summary: 'List team members',
    responses: {
      200: {
        description: 'Member list',
        content: { 'application/json': { schema: resolver(teamMemberListResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const teamId = c.req.param('teamId')

    const members = await services.teams.listMembers(teamId, hubId)
    return c.json({
      members: members.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    })
  },
)

// ---------------------------------------------------------------------------
// POST /teams/:teamId/members — add members
// ---------------------------------------------------------------------------

teams.post('/:teamId/members',
  describeRoute({
    tags: ['Teams'],
    summary: 'Add members to team',
    responses: {
      200: {
        description: 'Members added',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:manage'),
  validator('json', addTeamMembersBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const teamId = c.req.param('teamId')
    const { pubkeys } = c.req.valid('json')

    await services.teams.addMembers(teamId, hubId, pubkeys, pubkey)
    await audit(services.audit, 'teamMemberAdded', pubkey, { teamId, count: pubkeys.length }, undefined, hubId)
    return c.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// DELETE /teams/:teamId/members/:userPubkey — remove member
// ---------------------------------------------------------------------------

teams.delete('/:teamId/members/:userPubkey',
  describeRoute({
    tags: ['Teams'],
    summary: 'Remove member from team',
    responses: {
      200: {
        description: 'Member removed',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const teamId = c.req.param('teamId')
    const userPubkey = c.req.param('userPubkey')

    await services.teams.removeMember(teamId, hubId, userPubkey)
    await audit(services.audit, 'teamMemberRemoved', pubkey, { teamId }, undefined, hubId)
    return c.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// GET /teams/:teamId/contacts — list contact assignments
// ---------------------------------------------------------------------------

teams.get('/:teamId/contacts',
  describeRoute({
    tags: ['Teams'],
    summary: 'List contacts assigned to team',
    responses: {
      200: {
        description: 'Assignment list',
        content: { 'application/json': { schema: resolver(contactTeamAssignmentListResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const teamId = c.req.param('teamId')

    const assignments = await services.teams.listContactAssignments(teamId, hubId)
    return c.json({
      assignments: assignments.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
    })
  },
)

// ---------------------------------------------------------------------------
// POST /teams/:teamId/contacts — assign contacts
// ---------------------------------------------------------------------------

teams.post('/:teamId/contacts',
  describeRoute({
    tags: ['Teams'],
    summary: 'Assign contacts to team',
    responses: {
      200: {
        description: 'Contacts assigned',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:manage'),
  validator('json', assignTeamContactsBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const teamId = c.req.param('teamId')
    const { contactIds } = c.req.valid('json')

    await services.teams.assignContacts(teamId, hubId, contactIds, pubkey)
    await audit(services.audit, 'teamContactAssigned', pubkey, { teamId, count: contactIds.length }, undefined, hubId)
    return c.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// DELETE /teams/:teamId/contacts/:contactId — unassign contact
// ---------------------------------------------------------------------------

teams.delete('/:teamId/contacts/:contactId',
  describeRoute({
    tags: ['Teams'],
    summary: 'Remove contact from team',
    responses: {
      200: {
        description: 'Contact removed',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('teams:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const teamId = c.req.param('teamId')
    const contactId = c.req.param('contactId')

    await services.teams.unassignContact(teamId, hubId, contactId)
    await audit(services.audit, 'teamContactUnassigned', pubkey, { teamId, contactId }, undefined, hubId)
    return c.json({ ok: true })
  },
)

export default teams
