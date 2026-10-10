# Epic 99: Human Setup Guide

> **SUPERSEDED — 2026-10-09**
>
> This epic is retained as history. The setup-guide work it describes no longer
> matches what ships: the current deployment index is
> [`docs/deployment/README.md`](../deployment/README.md), and the backend this
> epic assumed (Cloudflare Workers, DO bindings, `wrangler` deploys) is not the
> backend that exists — see CLAUDE.md's backend description (`apps/worker/` is
> a Bun HTTP server on Hono + PostgreSQL, self-hosted; only the marketing site
> uses Cloudflare). The `**Status**` line below records authoring-time state
> and is not authoritative.

**Status**: In Progress
**Created**: 2026-02-26
**Depends on**: Epic 95 (Deployment Architecture), Epic 97 (Desktop Release Pipeline)

## Goal

Write a comprehensive setup guide for org admins deploying Llamenos — covering Twilio account setup, Cloudflare Workers deployment, self-hosted Docker deployment, admin bootstrap, and volunteer onboarding — so a non-developer admin can go from zero to running hotline.

## Scope

- `docs/SETUP.md` — main setup guide covering all deployment paths
- Twilio setup: account creation, phone number purchase, TwiML App configuration, webhook URLs
- Cloudflare Workers deployment: `wrangler` setup, secrets, DO bindings, custom domain
- Self-hosted Docker deployment: `docker compose up`, `.env` configuration, reverse proxy (Caddy/nginx)
- Admin bootstrap: `bun run bootstrap-admin`, importing keypair into desktop app
- Volunteer onboarding flow: admin creates invite, volunteer installs app, enters invite code
- Shift configuration: creating schedules, assigning ring groups
- Troubleshooting section: common issues (Twilio webhooks not reaching worker, DO errors, auth failures)
- `.env.example` file with documented variables for both CF Workers and self-hosted
- Quick-start checklist (TL;DR for experienced admins)

## Files Created/Modified

- `docs/SETUP.md`
- `.env.example` (documented template)
- `deploy/docker/.env.example` (Docker-specific)
- `docs/TROUBLESHOOTING.md` (optional, if setup guide gets too long)

## Dependencies

- Epic 95 complete (deployment architecture finalized)
- Epic 97 complete (release pipeline produces downloadable binaries)
- Twilio account and phone number (org responsibility)
- Cloudflare account or server for self-hosting (org responsibility)
