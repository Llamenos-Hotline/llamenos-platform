# Security Policy

## Reporting a Vulnerability

Llámenos protects vulnerable populations. We take security reports seriously and will respond promptly.

**Preferred method:** Use [GitHub's private security advisory feature](https://github.com/Llamenos-Hotline/llamenos-platform/security/advisories/new). This keeps the report confidential until a fix is ready.

**Encrypted communication:** If you need to communicate outside GitHub, contact the maintainers using the encrypted contact methods listed in the repository's signed releases.

## Scope

The following are in scope:

- Authentication and session handling (Ed25519 device keys, WebAuthn, device sigchain)
- End-to-end encryption of notes, messages, and call metadata
- Volunteer/caller identity protection
- Hub key management and rotation
- Telephony adapter webhook validation
- API authorization and privilege escalation
- Dependency vulnerabilities with known exploits affecting production builds
- Blast/broadcast subscriber data protection and access controls
- Entity and case record system (evidence chain integrity, field-level encryption)
- Recovery group: Shamir secret sharing, threshold reconstruction, liveness proofs
- Device wipe and account erasure (crypto-shredding, erasure override authentication)
- SAS emoji device verification (HKDF derivation, role-confusion resistance)

Out of scope: denial-of-service against self-hosted instances, issues requiring physical access to the server, social engineering.

## Response Timeline

- **Acknowledgement**: within 48 hours
- **Initial assessment**: within 5 business days
- **Fix or workaround**: depends on severity; critical issues prioritized immediately

We will credit reporters in release notes unless anonymity is requested.
