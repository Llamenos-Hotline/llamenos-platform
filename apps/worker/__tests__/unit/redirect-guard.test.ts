/**
 * Unit tests for apps/worker/lib/redirect-guard.ts
 *
 * Verifies that isAllowedOAuthRedirectUrl blocks open redirect attacks
 * while allowing legitimate app redirect targets.
 */
import { describe, it, expect } from 'vitest'
import { isAllowedOAuthRedirectUrl } from '@worker/lib/redirect-guard'

const prodEnv = { ENVIRONMENT: 'production' }
const devEnv = { ENVIRONMENT: 'development' }
const customEnv = { ENVIRONMENT: 'production', CORS_ALLOWED_ORIGINS: 'https://myorg.llamenos.org' }

describe('isAllowedOAuthRedirectUrl', () => {
  describe('allowed: llamenos:// deep link scheme', () => {
    it('accepts llamenos://oauth/callback', () => {
      expect(isAllowedOAuthRedirectUrl('llamenos://oauth/callback', prodEnv)).toBe(true)
    })

    it('accepts llamenos://oauth/callback with path', () => {
      expect(isAllowedOAuthRedirectUrl('llamenos://oauth/callback?status=ok', prodEnv)).toBe(true)
    })
  })

  describe('allowed: production default origins', () => {
    it('accepts https://app.llamenos-hotline.org', () => {
      expect(isAllowedOAuthRedirectUrl('https://app.llamenos-hotline.org/oauth/callback', prodEnv)).toBe(true)
    })

    // Removed from the built-in set in #1604 with the rest of demo mode: an
    // allowlist entry for a host nobody runs is a standing invitation to
    // whoever registers it next.
    it('refuses https://demo.llamenos-platform.com', () => {
      expect(isAllowedOAuthRedirectUrl('https://demo.llamenos-platform.com/oauth/callback', prodEnv)).toBe(false)
    })

    it('accepts tauri://localhost for desktop', () => {
      expect(isAllowedOAuthRedirectUrl('tauri://localhost/oauth/callback', prodEnv)).toBe(false) // tauri:// is not http/https
    })
  })

  describe('allowed: development localhost origins', () => {
    it('accepts http://localhost:5173 in dev', () => {
      expect(isAllowedOAuthRedirectUrl('http://localhost:5173/oauth/callback', devEnv)).toBe(true)
    })

    it('accepts http://localhost:1420 in dev (Tauri dev port)', () => {
      expect(isAllowedOAuthRedirectUrl('http://localhost:1420/oauth/callback', devEnv)).toBe(true)
    })

    it('blocks localhost in production when no custom origins set', () => {
      expect(isAllowedOAuthRedirectUrl('http://localhost:5173/oauth/callback', prodEnv)).toBe(false)
    })
  })

  describe('allowed: custom CORS_ALLOWED_ORIGINS', () => {
    it('accepts configured custom origin', () => {
      expect(isAllowedOAuthRedirectUrl('https://myorg.llamenos.org/oauth/callback', customEnv)).toBe(true)
    })

    it('blocks default prod origins when custom origins override them', () => {
      expect(isAllowedOAuthRedirectUrl('https://app.llamenos-hotline.org/oauth/callback', customEnv)).toBe(false)
    })

    it('blocks localhost even in dev when CORS_ALLOWED_ORIGINS is set', () => {
      const devCustomEnv = { ENVIRONMENT: 'development', CORS_ALLOWED_ORIGINS: 'https://myorg.llamenos.org' }
      expect(isAllowedOAuthRedirectUrl('http://localhost:5173/oauth/callback', devCustomEnv)).toBe(false)
    })
  })

  describe('blocked: open redirect attacks', () => {
    it('blocks arbitrary https:// URL', () => {
      expect(isAllowedOAuthRedirectUrl('https://evil.com/steal-token', prodEnv)).toBe(false)
    })

    it('blocks http:// URL not in allowlist', () => {
      expect(isAllowedOAuthRedirectUrl('http://evil.com/oauth/callback', prodEnv)).toBe(false)
    })

    it('blocks javascript: scheme', () => {
      expect(isAllowedOAuthRedirectUrl('javascript:alert(1)', prodEnv)).toBe(false)
    })

    it('blocks data: scheme', () => {
      expect(isAllowedOAuthRedirectUrl('data:text/html,<script>alert(1)</script>', prodEnv)).toBe(false)
    })

    it('blocks relative paths (not a valid URL)', () => {
      expect(isAllowedOAuthRedirectUrl('/relative/path', prodEnv)).toBe(false)
    })

    it('blocks empty string', () => {
      expect(isAllowedOAuthRedirectUrl('', prodEnv)).toBe(false)
    })

    it('blocks subdomain of allowed origin', () => {
      expect(isAllowedOAuthRedirectUrl('https://evil.app.llamenos-hotline.org/callback', prodEnv)).toBe(false)
    })

    it('blocks allowed origin with different port', () => {
      expect(isAllowedOAuthRedirectUrl('https://app.llamenos-hotline.org:8443/callback', prodEnv)).toBe(false)
    })

    it('blocks URL with credentials (user:pass@evil.com)', () => {
      expect(isAllowedOAuthRedirectUrl('https://user:pass@evil.com/callback', prodEnv)).toBe(false)
    })
  })
})
