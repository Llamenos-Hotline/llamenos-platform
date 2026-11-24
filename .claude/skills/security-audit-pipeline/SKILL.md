---
name: security-audit-pipeline
description: >
  Process security audit findings into dependency-ordered implementation epics for the Llamenos
  monorepo. Use this skill when conducting a security audit, reviewing security findings,
  processing vulnerability reports, creating security fix epics, or when the user mentions
  "security audit", "vulnerability", "findings", "security review", "pen test results",
  "audit round", "security issue", "security bug", "exploit", "insecure", "hardening", or
  "timing-unsafe". Also use when the user describes specific security problems inline — like
  missing auth checks, unsafe crypto operations, or data exposure — even without using the word
  "audit" or "vulnerability". If the user pastes or describes 2+ security issues that need
  triage and remediation, this skill applies. Covers all platforms: Worker backend, desktop
  (Tauri), iOS (SwiftUI), Android (Kotlin/Compose), crypto (Rust), CI/CD, and infrastructure.
---

# Security Audit Pipeline for Llamenos

This project has completed 8 security audit rounds with ~150+ findings across all platforms.
The workflow is well-established: findings are classified by severity, grouped by component,
decomposed into dependency-ordered epics, and implemented with mandatory verification tests.

## Pipeline Overview

```
Findings → Classify (CRITICAL/HIGH/MEDIUM/LOW)
         → Group by component (worker, crypto, desktop, iOS, Android, CI)
         → Order by dependency (crypto before mobile, worker before clients)
         → Generate epics (one per component group)
         → Implement with before/after code + negative-path tests
         → Verify all platforms build and tests pass
         → Update backlogs
```

## Step 1: Classify Findings

Every finding gets a severity level based on exploitability and impact:

| Severity | Criteria | Examples |
|----------|----------|---------|
| **CRITICAL** | Exploitable without auth, affects crypto/supply chain/core auth | Key exposure, webhook bypass, crypto weakness |
| **HIGH** | Requires some privilege but high impact, defense-in-depth failure | Legacy encryption callable, demo mode in prod, session issues |
| **MEDIUM** | Defense-in-depth, configuration hardening, incomplete validation | CORS allowlist, upload limits, rate limit gaps |
| **LOW** | Usability, documentation, accepted trade-offs | CSP comments, artifact retention, logging |

### Finding Format

Each finding should be documented as:

```markdown
### {ID} ({SEVERITY}): {Short description}

**Component**: Worker | Desktop | iOS | Android | Crypto | CI/CD
**File(s)**: `path/to/affected/file.ts:line`
**Description**: What the vulnerability is and how it can be exploited
**Impact**: What an attacker gains
**Remediation**: Specific fix approach
**Cross-platform**: Which other platforms need updates (if any)
**Verification**: How to confirm the fix works (specific test scenario)
```

## Step 2: Group by Component

Group findings into epic-sized chunks by affected component:

| Component | Epic scope | Typical findings |
|-----------|-----------|-----------------|
| **CI/CD & Supply Chain** | GitHub Actions, Docker images, dependency scanning | Action pinning, image digests, audit thresholds |
| **Protocol & Schema** | Wire format, JSON Schema constraints | Schema validation, legacy format removal |
| **Crypto (Rust)** | `packages/crypto/`, KDF, HPKE, Ed25519 | KDF upgrades, zeroization, interop, salt handling |
| **Worker** | `apps/worker/`, DOs, routes | Auth, rate limiting, webhook validation, data exposure |
| **Desktop (Tauri)** | `apps/desktop/`, `src/client/` | CSP, IPC, Stronghold, PIN lockout, updater |
| **iOS** | `apps/ios/` | Biometric, cert pinning, URL validation, keychain |
| **Android** | `apps/android/` | StrongBox, ProGuard, deep links, crypto hard-fail |

### Grouping Rules

- CRITICAL + HIGH findings for the same component go in one epic
- MEDIUM findings for the same component go in a separate epic (or combined if few)
- LOW findings can be grouped across components
- Crypto findings ALWAYS get their own epic (they block everything else)

## Step 3: Dependency Order

The standard dependency chain for security epics:

```
CI/CD (can run parallel with everything)
  ↓
Protocol & Schema
  ↓
Crypto (Rust crate)
  ↓
Worker (backend — uses crypto)
  ↓
Desktop (frontend — uses worker API + crypto via platform.ts)
  ↓
iOS (uses crypto via CryptoService FFI + worker API)
  ↓
Android (uses crypto via CryptoService JNI + worker API)
```

Why this order matters:
- Crypto wire format changes (e.g., HPKE algorithm upgrade) must land before any platform that encrypts/decrypts
- Worker API changes must land before clients that call those APIs
- CI/CD can harden independently without blocking feature work

## Step 4: Generate Epics

Use the `epic-authoring` skill with the security domain template. Each epic gets:

1. **Summary** with finding count and severity breakdown
2. **Finding-by-finding implementation** with before/after code
3. **Cross-platform impact** for each finding
4. **Verification tests** — EVERY finding needs at least one negative-path test

### Negative-Path Test Patterns

These are the most important tests in security work — they prove the vulnerability is gone:

```markdown
**Crypto**: Test that malformed/truncated ciphertext throws, not silently fails
**Auth**: Test that unauthenticated requests get 401, not data
**Input**: Test that oversized/malformed input gets 400, not processed
**Rate limit**: Test that exceeding limit gets 429, not allowed through
**Permissions**: Test that wrong role gets 403, not data from another role
**Config**: Test that sensitive values are NOT in public endpoints
```

### Breaking Change Management

When a fix changes wire format (e.g., HPKE algorithm upgrade):

1. Add a **version byte** to the new format
2. Implement **fallback detection** in the old format reader
3. Add **migration tests** that verify old ciphertext still decrypts
4. Document the **migration window** (how long to support both)
5. For pre-production (current state): clean break is acceptable — note it explicitly

## Step 5: Implementation Checklist

For each epic, verify:

- [ ] Every CRITICAL finding has a fix with before/after code
- [ ] Every HIGH finding has a fix with before/after code
- [ ] Every MEDIUM finding has a fix or documented accepted-risk rationale
- [ ] Every finding has at least one verification test
- [ ] Cross-platform impacts are traced (worker change → which clients?)
- [ ] Crypto changes have interop tests (Rust ↔ TS, Rust ↔ Swift, Rust ↔ Kotlin)
- [ ] No raw string literals used for crypto contexts (use `crypto-labels.json`)
- [ ] `bun run test:changed` passes for all affected platforms
- [ ] Each finding is filed as an issue and attached as a sub-issue of the relevant epic (planning index #2988)

## Step 6: Audit Report Documentation

After all epics are implemented, update or create an audit report:

**Location**: `docs/security/SECURITY_AUDIT_{DATE}.md`

**Structure**:
- Executive summary (total findings, severity breakdown, all-fixed status)
- Findings table with status (Fixed/Accepted/Deferred)
- Per-finding details with epic references
- Comparison with previous round (new vs recurring)
- Architecture notes for accepted trade-offs

## Recurring Finding Categories

These categories appear in almost every audit round — check them proactively:

1. **Cryptography**: KDF strength, salt handling, zeroization, domain separation
2. **Authentication**: Session management, token binding, brute-force protection
3. **Authorization**: Permission guards on all endpoints, role escalation prevention
4. **Input Validation**: SSRF, injection, schema constraints, size limits
5. **Supply Chain**: Action/image pinning, dependency scanning, lockfile integrity
6. **Data Exposure**: PII in logs/responses, key material in state, filename leakage
7. **Deployment**: Default credentials, debug endpoints, CORS, security headers

## Reference Files

- **Threat model**: `docs/security/THREAT_MODEL.md`
- **Deployment hardening**: `docs/security/DEPLOYMENT_HARDENING.md`
- **Protocol spec**: `docs/protocol/PROTOCOL.md`
- **Crypto labels**: `packages/protocol/crypto-labels.json` (68 domain separation constants)
- **Previous audits**: `docs/security/SECURITY_AUDIT_*.md`
