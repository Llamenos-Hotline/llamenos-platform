# Template Authoring Guide

This guide explains how to create custom templates for the Llamenos Case Management System. Templates are JSON files that define the entire structure of your CMS: entity types, fields, statuses, contact roles, report types, and suggested volunteer roles.

**Audience**: Operators and developers who want to create or customize CMS configurations for their organization.

---

## Table of Contents

1. [What Templates Are](#1-what-templates-are)
2. [Template Structure](#2-template-structure)
3. [Field Types](#3-field-types)
4. [Access Levels](#4-access-levels)
5. [Status Workflow](#5-status-workflow)
6. [Contact Roles](#6-contact-roles)
7. [Report Types](#7-report-types)
8. [PII Fields](#8-pii-fields)
9. [Blind Indexes](#9-blind-indexes)
10. [Template Composition](#10-template-composition)
11. [Suggested Roles](#11-suggested-roles)
12. [Translated Labels](#12-translated-labels)
13. [Example: Tenant Eviction Defense](#13-example-tenant-eviction-defense)

---

## 1. What Templates Are

A template is a JSON file that declares the complete CMS configuration for a particular use case. When an admin applies a template, Llamenos creates all the entity types, fields, statuses, relationships, and report types defined in that file.

Templates are **not hardcoded behavior**. They are data that drives the schema engine. Every aspect of the CMS -- what types of cases exist, what fields they have, who can see what, how statuses flow -- comes from templates. There is no code path that assumes "jail support" or "eviction defense" or any other specific use case.

Templates live in `packages/protocol/templates/` and are bundled into the application at build time. The API serves them via `GET /api/settings/cms/templates`.

### Bundled Templates

Llamenos ships with 14 templates:

| Template | File | Use Case |
|----------|------|----------|
| General Hotline | `general-hotline.json` | Basic call/note/follow-up tracking |
| Jail Support | `jail-support.json` | Mass arrest intake, arraignment, bail coordination |
| Legal Observer | `legal-observer.json` | Field documentation of police conduct |
| Street Medic | `street-medic.json` | Protest medical encounter triage and treatment |
| DV/IPV Crisis | `dv-crisis.json` | Domestic violence safety planning and shelter placement |
| ICE Rapid Response | `ice-rapid-response.json` | Immigration enforcement raid response |
| Copwatch | `copwatch.json` | Police accountability and incident documentation |
| Hate Crime Reporting | `hate-crime-reporting.json` | Hate crime/bias incident documentation |
| Bail Fund | `bail-fund.json` | Community bail fund case and payment tracking |
| Mutual Aid | `mutual-aid.json` | Mutual aid request fulfillment |
| Stop the Sweeps | `stop-the-sweeps.json` | Unhoused encampment defense |
| Missing Persons | `missing-persons.json` | Community-based missing persons coordination |
| KYR Training | `kyr-training.json` | Know Your Rights training event management |
| Tenant Organizing | `tenant-organizing.json` | Eviction defense and tenant union organizing |

---

## 2. Template Structure

Every template is a JSON object with these top-level keys:

```json
{
  "id": "my-template",
  "version": "1.0.0",
  "name": "My Template",
  "description": "What this template is for.",
  "author": "Your Organization",
  "license": "CC-BY-SA-4.0",
  "tags": ["housing", "legal"],
  "extends": [],

  "labels": { ... },
  "entityTypes": [ ... ],
  "relationshipTypes": [ ... ],
  "reportTypes": [ ... ],
  "suggestedRoles": [ ... ]
}
```

| Key | Required | Description |
|-----|----------|-------------|
| `id` | Yes | Unique slug. Lowercase, hyphens only. |
| `version` | Yes | Semver string. Used for update detection. |
| `name` | Yes | Human-readable name shown in the Template Browser. |
| `description` | Yes | Explains the use case. Shown in the Template Browser. |
| `author` | Yes | Who wrote the template. |
| `license` | Yes | License for the template itself. |
| `tags` | Yes | Array of lowercase tags for filtering. |
| `extends` | No | Array of template IDs this template builds on (see [Section 10](#10-template-composition)). |
| `labels` | Yes | Translated strings keyed by locale (see [Section 12](#12-translated-labels)). |
| `entityTypes` | Yes | Array of entity type definitions. |
| `relationshipTypes` | No | Array of relationship type definitions linking entity types. |
| `reportTypes` | No | Array of report type definitions (see [Section 7](#7-report-types)). |
| `suggestedRoles` | No | Array of volunteer role presets (see [Section 11](#11-suggested-roles)). |

---

## 3. Field Types

Each entity type and report type contains a `fields` array. Every field has a `type` that determines how it renders and what values it accepts.

| Type | Description | Options Required |
|------|-------------|-----------------|
| `text` | Single-line text input | No |
| `textarea` | Multi-line text input. Supports `supportAudioInput: true` for voice dictation on mobile. | No |
| `number` | Numeric input | No |
| `date` | Date picker | No |
| `checkbox` | Boolean toggle | No |
| `select` | Single-choice dropdown | Yes |
| `multiselect` | Multi-choice tag picker | Yes |
| `file` | File upload reference | No |

### Field Definition Properties

```json
{
  "name": "arrest_location",
  "label": "Arrest Location",
  "type": "text",
  "required": true,
  "section": "arrest_details",
  "helpText": "Intersection or landmark where the arrest occurred.",
  "order": 2,
  "indexable": false,
  "indexType": "exact",
  "accessLevel": "all",
  "showWhen": { "field": "some_field", "operator": "equals", "value": "some_value" },
  "supportAudioInput": true
}
```

| Property | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Machine-readable identifier. Lowercase, underscores. Must be unique within the entity type. |
| `label` | Yes | Human-readable label shown in the UI. |
| `type` | Yes | One of the types listed above. |
| `required` | Yes | Whether the field must be filled to save the record. |
| `section` | No | Groups fields visually in the form. Fields with the same `section` string render together. |
| `helpText` | No | Explanatory text shown below the field. |
| `order` | Yes | Display order (ascending). |
| `indexable` | No | Whether a blind index is created for server-side search (see [Section 9](#9-blind-indexes)). |
| `indexType` | No | Index strategy: `"exact"` for equality matching. Required when `indexable: true`. |
| `accessLevel` | Yes | Who can see this field (see [Section 4](#4-access-levels)). |
| `showWhen` | No | Conditional visibility rule. The field is hidden unless the condition is met. |
| `supportAudioInput` | No | For `textarea` fields only. Enables voice-to-text input on mobile clients. |

### Options (for `select` and `multiselect`)

```json
"options": [
  { "key": "misdemeanor", "label": "Misdemeanor" },
  { "key": "felony", "label": "Felony" }
]
```

Each option has a `key` (stored value) and `label` (display text). Keys should be lowercase with underscores.

### Conditional Visibility (`showWhen`)

Fields can be shown or hidden based on another field's value:

```json
"showWhen": { "field": "bail_status", "operator": "equals", "value": "posted" }
```

Supported operators: `equals`, `not_equals`.

---

## 4. Access Levels

Every field has an `accessLevel` that controls who can read it. Entity types also have a `defaultAccessLevel` that applies to the record as a whole.

| Level | Who Can See |
|-------|-------------|
| `all` | All authenticated volunteers in the hub |
| `assigned` | Only the volunteer assigned to the case, plus admins |
| `admin` | Admins only |
| `hub` | All members of the hub (used for event-type entities that need broad visibility) |
| `custom` | Access controlled by per-record permission grants |

Choose the most restrictive level that still allows the workflow to function. For example:

- **Booking numbers and court dates** (`assigned`) -- only the assigned volunteer needs this to do their job.
- **Arrest location and arresting agency** (`all`) -- everyone on the hotline needs this for coordination.
- **Attorney phone numbers** (`admin`) -- PII that only admins should access.
- **Immigration hold flags** (`admin`) -- extremely sensitive, admin-only.

The `defaultAccessLevel` on the entity type controls who can see the record's existence and summary fields. Individual field `accessLevel` values can be more restrictive than the entity default but never less restrictive.

---

## 5. Status Workflow

Each entity type defines a `statuses` array, a `defaultStatus`, and a `closedStatuses` array.

```json
"statuses": [
  { "value": "intake", "label": "Intake", "color": "#f59e0b", "order": 1 },
  { "value": "organizing", "label": "Organizing", "color": "#3b82f6", "order": 2 },
  { "value": "in_court", "label": "In Court", "color": "#ef4444", "order": 3 },
  { "value": "settled", "label": "Settled", "color": "#22c55e", "order": 4, "isClosed": true },
  { "value": "dismissed", "label": "Dismissed", "color": "#22c55e", "order": 5, "isClosed": true },
  { "value": "evicted", "label": "Evicted", "color": "#6b7280", "order": 6, "isClosed": true }
],
"defaultStatus": "intake",
"closedStatuses": ["settled", "dismissed", "evicted"]
```

| Property | Description |
|----------|-------------|
| `value` | Machine-readable status identifier. Lowercase, underscores. |
| `label` | Human-readable label. |
| `color` | Hex color for status badges. |
| `order` | Display order in dropdowns and kanban boards. |
| `isClosed` | Mark as `true` for terminal statuses. These are listed in `closedStatuses`. |

**Design guidance**:
- Start with a clear intake/open status as the default.
- Include at least one closed status. Records in closed statuses are hidden from active views by default.
- Multiple closed statuses are useful when the outcome matters (e.g., "Settled" vs. "Evicted" vs. "Dismissed").
- Status transitions are not restricted -- any status can move to any other status. Llamenos does not enforce a DAG.

### Severities (Optional)

Entity types can define a `severities` array for triage prioritization:

```json
"severities": [
  { "value": "emergency", "label": "Emergency (marshal notice, lockout)", "color": "#ef4444", "icon": "alert-triangle", "order": 1 },
  { "value": "urgent", "label": "Urgent (court date imminent)", "color": "#f59e0b", "order": 2 },
  { "value": "standard", "label": "Standard", "color": "#3b82f6", "order": 3 }
],
"defaultSeverity": "standard"
```

---

## 6. Contact Roles

Each entity type defines a `contactRoles` array that specifies what roles a contact can play in relation to that entity:

```json
"contactRoles": [
  { "value": "tenant", "label": "Tenant", "order": 1 },
  { "value": "attorney", "label": "Attorney", "order": 2 },
  { "value": "organizer", "label": "Organizer", "order": 3 },
  { "value": "landlord_contact", "label": "Landlord / Management Contact", "order": 4 }
]
```

Contact roles are also mirrored in `relationshipTypes` to define the full relationship between contacts and entity types:

```json
"relationshipTypes": [
  {
    "sourceEntityTypeName": "contact",
    "targetEntityTypeName": "eviction_defense_case",
    "cardinality": "M:N",
    "label": "Eviction Defense Cases",
    "reverseLabel": "Contacts",
    "sourceLabel": "has case",
    "targetLabel": "involves",
    "roles": [
      { "value": "tenant", "label": "Tenant", "order": 1 },
      { "value": "attorney", "label": "Attorney", "order": 2 }
    ],
    "defaultRole": "tenant",
    "cascadeDelete": false,
    "required": true
  }
]
```

| Property | Description |
|----------|-------------|
| `sourceEntityTypeName` | The "from" side. Use `"contact"` for contact-to-case relationships. |
| `targetEntityTypeName` | The "to" side. Must match an entity type `name` in this template. |
| `cardinality` | `"M:N"` (many-to-many) or `"1:N"` (one-to-many). |
| `roles` | What role the source plays in the relationship. |
| `defaultRole` | The pre-selected role when creating a new link. |
| `required` | Whether every record of the target type must have at least one relationship of this kind. |
| `cascadeDelete` | Whether deleting the source deletes the target. Almost always `false`. |

You can also define entity-to-entity relationships (e.g., linking arrest cases to mass arrest events):

```json
{
  "sourceEntityTypeName": "arrest_case",
  "targetEntityTypeName": "mass_arrest_event",
  "cardinality": "M:N",
  "label": "Related Events",
  "reverseLabel": "Arrest Cases",
  "sourceLabel": "part of",
  "targetLabel": "includes",
  "cascadeDelete": false,
  "required": false
}
```

---

## 7. Report Types

Report types define structured forms that volunteers submit from the field (typically on mobile). Reports differ from entity types in that they are lightweight, submission-oriented, and can optionally be converted into full cases.

```json
"reportTypes": [
  {
    "name": "lo_arrest_report",
    "label": "lo_arrest_report.label",
    "labelPlural": "lo_arrest_report.labelPlural",
    "description": "lo_arrest_report.description",
    "icon": "clipboard-list",
    "color": "#ef4444",
    "allowFileAttachments": true,
    "allowCaseConversion": true,
    "mobileOptimized": true,
    "numberPrefix": "AR",
    "numberingEnabled": true,
    "statuses": [ ... ],
    "defaultStatus": "submitted",
    "closedStatuses": ["closed"],
    "fields": [ ... ]
  }
]
```

### Report-Specific Properties

| Property | Description |
|----------|-------------|
| `allowCaseConversion` | If `true`, admins can convert a submitted report into a full case record. |
| `mobileOptimized` | If `true`, the mobile UI uses a simplified single-column layout for field entry. |
| `allowFileAttachments` | If `true`, volunteers can attach photos and files to the report. |
| `supportAudioInput` | Set on individual `textarea` fields. Enables voice dictation via the device microphone. |

Report types have their own `statuses`, `fields`, and lifecycle independent of entity types. A typical flow:

1. Volunteer submits report from mobile (status: `submitted`)
2. Coordinator reviews and triages (status: `in_review` or `triaged`)
3. If `allowCaseConversion` is true, coordinator converts report to a case
4. Report is closed (status: `closed`)

---

## 8. PII Fields

Fields that contain personally identifiable information should be listed in the entity type's `piiFields` array:

```json
{
  "name": "eviction_defense_case",
  "piiFields": ["unit_number", "rent_amount", "arrears"],
  ...
}
```

PII fields receive a higher encryption tier. While all case data is encrypted at the field level, PII fields are additionally:

- Encrypted with a restricted key that requires explicit PII access permission (`contacts:view-pii`)
- Excluded from summary/preview text that appears in lists and notifications
- Logged separately in the audit trail when accessed

Mark a field as PII if it could identify a specific individual when combined with other data: names, addresses, phone numbers, financial details, medical information, immigration status.

---

## 9. Blind Indexes

Blind indexes allow the server to search encrypted records without decrypting them. When a field is marked `indexable: true`, the client computes an HMAC of the field value and stores it alongside the encrypted data. The server can match on these HMACs without ever seeing the plaintext.

```json
{
  "name": "booking_number",
  "label": "Booking Number",
  "type": "text",
  "indexable": true,
  "indexType": "exact",
  ...
}
```

### When to Index

Mark a field as indexable when volunteers need to search or filter by that field:

- **Index**: Booking numbers, docket numbers, status fields, date fields, category selectors
- **Do not index**: Free-text descriptions, notes, medical details, attorney names

### Index Types

Currently only `"exact"` is supported, which matches on full field value equality. The HMAC is computed from the lowercased, trimmed field value using the hub's HMAC key.

### Performance Considerations

Each indexable field adds one HMAC computation on write and one comparison per record on search. Keep the number of indexable fields reasonable (under 10 per entity type is a good target).

---

## 10. Template Composition

Templates can extend other templates using the `extends` array:

```json
{
  "id": "my-custom-template",
  "extends": ["general-hotline"],
  ...
}
```

When a template extends another:

1. All entity types from the parent template are included
2. The child template can add new entity types
3. The child template can add new fields to parent entity types by defining an entity type with the same `name` and additional fields
4. Relationship types and report types from the parent are included

Version tracking ensures that when a parent template is updated, the system can detect and offer updates to hubs using the child template.

### Version Tracking

When a template is applied, the system records:

- Template ID and version
- Timestamp of application
- Which entity types, fields, and report types were created

The `GET /api/settings/cms/templates/updates` endpoint checks applied templates against bundled versions and reports available updates.

---

## 11. Suggested Roles

Templates can suggest volunteer roles with pre-configured permissions:

```json
"suggestedRoles": [
  {
    "name": "Intake Volunteer",
    "slug": "intake-volunteer",
    "description": "Takes initial calls, creates case records",
    "permissions": [
      "cases:create",
      "cases:read-own",
      "cases:update-own",
      "contacts:create",
      "contacts:view",
      "calls:answer",
      "notes:create",
      "notes:read-own",
      "shifts:read-own"
    ]
  }
]
```

After applying a template, admins can import these roles via **Settings > Roles > Import from template**. The client seals each role's name and description under the hub key (`LABEL_HUB_ROLE_ENCRYPT`) and creates it with `POST /api/hubs/:hubId/settings/roles`; the server never writes a role name in the clear (#2780). Because a role's permission set is stored in the clear, a role imported unmodified can be matched to its template entry — vary the permissions if that matters.

Suggested roles are recommendations, not requirements. Admins can modify permissions, rename roles, or create entirely different role structures.

---

## 12. Translated Labels

Templates use a `labels` object to provide translated strings for entity type and report type names:

```json
"labels": {
  "en": {
    "eviction_defense_case.label": "Eviction Defense Case",
    "eviction_defense_case.labelPlural": "Eviction Defense Cases",
    "eviction_defense_case.description": "Track an eviction case through intake, organizing, legal representation, and housing court"
  },
  "es": {
    "eviction_defense_case.label": "Caso de Defensa contra Desalojo",
    "eviction_defense_case.labelPlural": "Casos de Defensa contra Desalojo",
    "eviction_defense_case.description": "Seguimiento de un caso de desalojo a traves de la organizacion, representacion legal y tribunal de vivienda"
  }
}
```

Entity types and report types reference these labels by key rather than using literal strings:

```json
{
  "name": "eviction_defense_case",
  "label": "eviction_defense_case.label",
  "labelPlural": "eviction_defense_case.labelPlural",
  "description": "eviction_defense_case.description"
}
```

Include at minimum `en` and `es` translations. Llamenos supports 13 locales: en, es, zh, tl, vi, ar, fr, ht, ko, ru, hi, pt, de.

---

## 13. Example: Tenant Eviction Defense

This walkthrough shows the key decisions when building the `tenant-organizing.json` template, which ships with Llamenos.

### Step 1: Define the Entity Type

The primary entity is an eviction defense case. Key decisions:

- **`numberPrefix: "ED"`** -- cases get sequential IDs like ED-001, ED-002
- **`defaultAccessLevel: "assigned"`** -- only the assigned organizer sees the case by default
- **`piiFields: ["unit_number", "rent_amount", "arrears"]`** -- financial data gets restricted encryption
- **`allowSubRecords: true`** -- a building-level case can have per-unit sub-records

### Step 2: Design the Status Workflow

Eviction defense has multiple possible outcomes, so we need several closed statuses:

```
intake -> organizing -> legal_representation -> in_court -> settled | dismissed | evicted
```

The status `evicted` is a closed status (the case is over) but it is a negative outcome, so it gets a gray color rather than green.

### Step 3: Choose Fields and Access Levels

The template groups fields into sections:

| Section | Fields | Access |
|---------|--------|--------|
| `property` | Unit number, landlord name | `assigned` |
| `legal` | Eviction type, attorney status | `all` (volunteers need this for triage) |
| `court` | Court date, index number | `assigned` |
| `financial` | Monthly rent, arrears | `admin` (sensitive PII) |
| `conditions` | Housing violations count, HP action filed | `assigned` |
| `protections` | Rent stabilized, Section 8 voucher | `assigned` |
| `household` | Household size, children present | `assigned` |

### Step 4: Make Key Fields Indexable

For search:

- `eviction_type` (exact) -- filter cases by type
- `court_date` (exact) -- find cases with upcoming court dates
- `index_number` (exact) -- look up by court case number
- `attorney_status` (exact) -- find cases that need attorneys
- `hp_action` (exact) -- find cases with active HP actions
- `rent_stabilized`, `section_8`, `children_present` (exact) -- filter by protection status

### Step 5: Define Contact Roles and Relationships

Each case involves people in specific roles:

```json
"contactRoles": [
  { "value": "tenant", "label": "Tenant", "order": 1 },
  { "value": "co_tenant", "label": "Co-Tenant", "order": 2 },
  { "value": "attorney", "label": "Attorney", "order": 3 },
  { "value": "organizer", "label": "Organizer", "order": 4 },
  { "value": "landlord_contact", "label": "Landlord / Management Contact", "order": 5 },
  { "value": "housing_inspector", "label": "Housing Inspector", "order": 6 }
]
```

The relationship type sets `required: true` because every eviction case must have at least one contact (the tenant).

### Step 6: Suggest Roles

The template suggests four roles with escalating permissions:

- **Intake Volunteer** -- can create cases and their own notes
- **Tenant Organizer** -- can create cases, manage their own, read events
- **Housing Attorney** -- full case read access, PII access, evidence management
- **Campaign Coordinator** -- full access to everything for building-wide campaigns

### Step 7: Add Translations

At minimum, provide `en` and `es` labels for entity type names, plural forms, and descriptions.

### Applying the Template

Once the JSON file is in `packages/protocol/templates/`, rebuild the application. The template appears in **Admin > Settings > Case Management > Template Browser**. Applying it creates the entity type, fields, statuses, relationships, and makes the suggested roles available for creation.

---

## Validating Your Template

Templates are validated at application time against the `EntityTypeDefinition` and `ReportTypeDefinition` schemas defined in `packages/protocol/schemas/`. Common validation errors:

- Duplicate field `name` values within an entity type
- Missing `options` array on `select` or `multiselect` fields
- `showWhen` referencing a field `name` that does not exist
- `indexType` specified without `indexable: true`
- `closedStatuses` referencing a status `value` that does not exist in `statuses`
- `piiFields` referencing a field `name` that does not exist in `fields`

Run `bun run codegen` after adding a template to verify it passes schema validation.
