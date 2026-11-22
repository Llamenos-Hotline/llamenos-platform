# Llamenos Protocol: Permission model

> Part of the [Llamenos Interoperability Protocol](PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

## 7. Permission Model

Llamenos uses Permission-Based Access Control (PBAC). Users are assigned roles, and each role is a named bundle of permissions. Effective permissions are the union of all assigned roles.

### 7.1 Permission Format

Permissions are colon-separated strings: `domain:action`.

```
calls:answer
notes:read-own
settings:manage-telephony
system:manage-roles
```

### 7.2 Wildcard Support

| Pattern | Meaning |
|---------|---------|
| `*` | Global wildcard -- grants ALL permissions |
| `domain:*` | Domain wildcard -- grants all actions in domain (e.g., `calls:*` grants `calls:answer`, `calls:read-active`, etc.) |

### 7.3 Permission Resolution

```
permissionGranted(granted_permissions[], required_permission):
  1. If granted includes "*" -> true
  2. If granted includes exact match -> true
  3. domain = required_permission.split(":")[0]
     If granted includes "domain:*" -> true
  4. Return false
```

For multiple roles:

```
resolvePermissions(role_ids[], all_role_definitions[]):
  permissions = Set()
  for each role_id in role_ids:
    role = find role by id
    for each permission in role.permissions:
      permissions.add(permission)
  return Array.from(permissions)
```

### 7.4 Permission Catalog

#### Calls

| Permission | Description |
|------------|-------------|
| `calls:answer` | Answer incoming calls |
| `calls:read-active` | See active calls (caller info redacted) |
| `calls:read-active-full` | See active calls with full caller info |
| `calls:read-history` | View call history |
| `calls:read-own-history` | View the calls you answered, within the hub access window (#1342) |
| `calls:read-presence` | View volunteer presence |
| `calls:read-recording` | Listen to call recordings |
| `calls:debug` | Debug call state |

#### Notes

| Permission | Description |
|------------|-------------|
| `notes:create` | Create call notes |
| `notes:read-own` | Read own notes |
| `notes:read-all` | Read all notes |
| `notes:read-assigned` | Read notes from assigned volunteers |
| `notes:update-own` | Update own notes |

#### Reports

| Permission | Description |
|------------|-------------|
| `reports:create` | Submit reports |
| `reports:read-own` | Read own reports |
| `reports:read-all` | Read all reports |
| `reports:read-assigned` | Read assigned reports |
| `reports:assign` | Assign reports to reviewers/volunteers |
| `reports:update` | Update report status |
| `reports:send-message-own` | Send messages in own reports |
| `reports:send-message` | Send messages in any report |

#### Conversations

| Permission | Description |
|------------|-------------|
| `conversations:read-assigned` | Read assigned + waiting conversations |
| `conversations:read-all` | Read all conversations |
| `conversations:claim` | Claim a waiting conversation |
| `conversations:claim-sms` | Claim SMS conversations |
| `conversations:claim-whatsapp` | Claim WhatsApp conversations |
| `conversations:claim-signal` | Claim Signal conversations |
| `conversations:claim-rcs` | Claim RCS conversations |
| `conversations:claim-web` | Claim web conversations |
| `conversations:claim-any` | Claim any channel (bypass restrictions) |
| `conversations:send` | Send messages in assigned conversations |
| `conversations:send-any` | Send messages in any conversation |
| `conversations:update` | Reassign/close/reopen conversations |

#### Users

| Permission | Description |
|------------|-------------|
| `users:read` | List/view user profiles |
| `users:create` | Create new users |
| `users:update` | Update user profiles |
| `users:delete` | Deactivate/delete users |
| `users:manage-roles` | Assign/change user roles |
| `users:read-cases` | View cases assigned to a user |
| `users:read-metrics` | View user workload metrics |
| `users:manage-devices` | Manage user devices and sigchain |

#### Shifts

| Permission | Description |
|------------|-------------|
| `shifts:read-own` | Check own shift status |
| `shifts:read` | View all shifts |
| `shifts:create` | Create shifts |
| `shifts:update` | Modify shifts |
| `shifts:delete` | Delete shifts |
| `shifts:manage-fallback` | Manage fallback ring group |

#### Bans

| Permission | Description |
|------------|-------------|
| `bans:report` | Report/flag a number |
| `bans:read` | View ban list |
| `bans:create` | Ban numbers |
| `bans:bulk-create` | Bulk ban import |
| `bans:delete` | Remove bans |

#### Invites

| Permission | Description |
|------------|-------------|
| `invites:read` | View pending invites |
| `invites:create` | Create invite codes |
| `invites:revoke` | Revoke invite codes |

#### Settings

| Permission | Description |
|------------|-------------|
| `settings:read` | View settings |
| `settings:manage` | Modify all settings |
| `settings:manage-telephony` | Modify telephony provider |
| `settings:manage-messaging` | Modify messaging channels |
| `settings:manage-spam` | Modify spam settings |
| `settings:manage-ivr` | Modify IVR/language settings |
| `settings:manage-fields` | Modify custom fields |
| `settings:manage-transcription` | Modify transcription settings |

#### Audit

| Permission | Description |
|------------|-------------|
| `audit:read` | View audit log |

#### Blasts

| Permission | Description |
|------------|-------------|
| `blasts:read` | View blast history |
| `blasts:send` | Send blasts |
| `blasts:manage` | Manage subscriber lists and templates |
| `blasts:schedule` | Schedule future blasts |

#### Files

| Permission | Description |
|------------|-------------|
| `files:upload` | Upload files |
| `files:download-own` | Download own/authorized files |
| `files:download-all` | Download any file |
| `files:share` | Re-encrypt/share files with others |

#### System (Super-Admin Only)

| Permission | Description |
|------------|-------------|
| `system:manage-roles` | Create/edit/delete custom roles |
| `system:manage-hubs` | Create/manage hubs |
| `system:manage-instance` | Instance-level settings |

### 7.5 Default Roles

#### Super Admin (`role-super-admin`)

```
Permissions: ["*"]
System role: true (cannot be modified or deleted)
```

Full system access. Creates hubs, manages all settings and users. This is authority over the instance, not over its data: a super-admin is zero-knowledge and is never a reader of any hub's records (see the admin invariant in §4.15).

#### Hub Admin (`role-hub-admin`)

```
Permissions: [
  "users:*", "shifts:*", "settings:*", "audit:read",
  "bans:*", "invites:*", "notes:read-all", "notes:create", "notes:update-own",
  "reports:*", "conversations:*", "calls:*", "blasts:*", "files:*"
]
```

Full control within assigned hub(s). Manages users, shifts, settings.

#### Reviewer (`role-reviewer`)

```
Permissions: [
  "notes:read-assigned", "reports:read-assigned", "reports:assign",
  "reports:update", "reports:send-message",
  "conversations:read-assigned", "conversations:send",
  "shifts:read-own", "files:download-own", "files:upload"
]
```

Reviews notes and reports from assigned volunteers or shifts.

#### Volunteer (`role-volunteer`)

```
Permissions: [
  "calls:answer", "calls:read-active", "calls:hangup", "calls:report-spam",
  "calls:identify-caller",
  "notes:create", "notes:read-own", "notes:update-own", "notes:reply",
  "contacts:search",
  "conversations:claim", "conversations:send", "conversations:read-assigned",
  "conversations:claim-sms", "conversations:claim-whatsapp",
  "conversations:claim-signal", "conversations:claim-rcs", "conversations:claim-web",
  "shifts:read-own", "shifts:set-availability", "shifts:request-join",
  "bans:report",
  "reports:read-assigned", "reports:read-types", "reports:send-message",
  "settings:read",
  "files:upload", "files:download-own",
  "cases:create", "cases:read-own", "cases:update-own",
  "events:read", "evidence:upload",
  "hubs:read",
  "erasure:request-self",
  "teams:read", "tags:view"
]
```

Answers calls, writes notes, handles assigned conversations.

#### Reporter (`role-reporter`)

```
Permissions: [
  "reports:create", "reports:read-own", "reports:send-message-own",
  "files:upload", "files:download-own"
]
```

Submits reports and tracks their own submissions.

### 7.6 Hub-Scoped Permissions

Users can have different roles in different hubs. Permission resolution checks both global roles and hub-specific roles:

```
hasHubPermission(global_roles, hub_roles, all_role_defs, hub_id, permission):
  1. global_perms = resolvePermissions(global_roles, all_role_defs)
     If permissionGranted(global_perms, permission) -> true  (super-admin bypasses)
  2. assignment = hub_roles.find(hr => hr.hubId === hub_id)
     If no assignment -> false
  3. hub_perms = resolvePermissions(assignment.roleIds, all_role_defs)
     Return permissionGranted(hub_perms, permission)
```

### 7.7 Channel Claim Permissions

Claiming a conversation requires both the general `conversations:claim` permission and a channel-specific permission:

| Channel | Required Permission |
|---------|-------------------|
| SMS | `conversations:claim-sms` |
| WhatsApp | `conversations:claim-whatsapp` |
| Signal | `conversations:claim-signal` |
| RCS | `conversations:claim-rcs` |
| Web | `conversations:claim-web` |
| Any (bypass) | `conversations:claim-any` |

---

