# Documentation Guide

This guide explains the structure of the `docs/` directory and where to find (or add) different kinds of documentation.

## Current Documentation (Active)

### `docs/protocol/`
Authoritative cross-platform wire format, crypto, API, and permission specification.
- `PROTOCOL.md` — the canonical protocol spec; all platforms implement this
- `llamenos-protocol.md` — supplementary protocol notes

### `docs/superpowers/specs/`
Current feature specifications, written during the brainstorming → spec phase.
New feature work starts here. Format: `YYYY-MM-DD-<descriptor>.md`

### `docs/superpowers/plans/`
Current implementation plans, generated from specs before execution.
Format: `YYYY-MM-DD-<descriptor>.md`

### `docs/security/`
Security audit preparation docs, threat model, and hardening guides.
- `THREAT_MODEL.md` — adversary model and trust boundaries
- `DATA_CLASSIFICATION.md` — data sensitivity tiers
- `DEPLOYMENT_HARDENING.md` — production hardening checklist
- `SECURITY_AUDIT_*.md` — security audit reports
- `CERTIFICATE_PINS.md` — TLS pinning configuration
- `KEY_REVOCATION_RUNBOOK.md` — key compromise response procedures

### `docs/architecture/`
In-depth architecture documentation for specific subsystems.
- `E2EE_ARCHITECTURE.md` — end-to-end encryption design

### `docs/operations/`
Operational runbooks for deployed systems.
- `key-rotation.md` — hub key and device key rotation procedures

### `docs/api/`
API reference documentation.
- `case-management.md` — Case Management System API reference

### Top-Level Docs

| File | Purpose |
|------|---------|
| `QUICKSTART.md` | Getting started — all platforms, dev setup |
| `OPERATOR_HANDBOOK.md` | Hub operator guide (setup, config, admin tasks) |
| `TEMPLATE_AUTHORING.md` | CMS template authoring guide |
| `REPRODUCIBLE_BUILDS.md` | Build verification and SLSA provenance |
| `DESKTOP_BUILD.md` | Desktop release build instructions |
| `RUNBOOK.md` | Production incident runbook |
| `RELAY_OPERATIONS.md` | WebSocket relay operations |
| `CAPACITY_PLANNING.md` | Scaling and capacity planning guidance |
| `QUICK_REFERENCE.md` | Developer quick-reference card |
| `NEXT_BACKLOG.md` | Pointer only — pending work is tracked as GitHub epics; planning index is #2988 |
| `HUMAN_INSTRUCTIONS.md` | Instructions for human contributors |
| `DESIGN.md` | Original design notes and threat model rationale |
| `COMPLETED_BACKLOG.md` | Historical record of completed work |

---

## Archived Documentation (Do Not Add New Files)

### `docs/epics/` — ARCHIVED
Legacy epic documents from the pre-superpowers planning workflow.
262 epic files (`epic-*.md`) covering the project's full history.
Retained for historical reference. See `docs/epics/README.md`.

### `docs/plans/` — ARCHIVED
Legacy planning documents from the pre-superpowers workflow.
Retained for historical reference. See `docs/plans/README.md`.

---

## Where to Put New Documentation

| What you're writing | Where it goes |
|--------------------|---------------|
| New feature spec | `docs/superpowers/specs/YYYY-MM-DD-<name>.md` |
| Implementation plan | `docs/superpowers/plans/YYYY-MM-DD-<name>.md` |
| Protocol change | `docs/protocol/PROTOCOL.md` (edit in place) |
| Security finding / audit | `docs/security/` |
| Architecture deep-dive | `docs/architecture/` |
| Operational runbook | `docs/operations/` |
| API reference | `docs/api/` |
| Operator-facing guide | `docs/OPERATOR_HANDBOOK.md` or `docs/operations/` |

---

## Development Workflow

New feature development follows the superpowers workflow:

1. **Brainstorm** (`superpowers:brainstorming`) → spec in `docs/superpowers/specs/`
2. **Plan** (`superpowers:writing-plans`) → plan in `docs/superpowers/plans/`
3. **Execute** (`superpowers:executing-plans`) → implementation in a worktree

See `CLAUDE.md` for the full development workflow.
