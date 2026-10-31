import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import invitePage, { pickLocale } from '@worker/routes/invite-page'
import { LANGUAGE_CODES } from '@llamenos/i18n'
import { locales } from '@llamenos/i18n'

const CODE = '3f2b8c1e-9a4d-4e7b-8c55-0d1f2a3b4c5d'

/**
 * Words that would name the organisation, the service, or the product. The page
 * is seen by link-preview bots, mail providers and whoever holds the device, so
 * none of them may appear anywhere in the response — title and meta included.
 */
const IDENTIFYING = [/llamenos/i, /llámenos/i, /hotline/i, /crisis/i, /ACME Crisis Line/i, /Hub Name/i, /og:/i]

function createApp(opts: {
  validate?: { valid: boolean; error?: string; name?: string; roleIds?: string[] }
  limited?: boolean
  downloadUrl?: string
} = {}) {
  const validateInvite = vi.fn().mockResolvedValue(opts.validate ?? { valid: true, name: 'Hub Name Volunteer', roleIds: ['role-volunteer'] })
  const checkRateLimit = vi.fn().mockResolvedValue({ limited: opts.limited ?? false })
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', {
      identity: { validateInvite },
      settings: { checkRateLimit },
    } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/onboarding', invitePage)
  const env = { HMAC_SECRET: 'x'.repeat(64), ENVIRONMENT: 'test', APP_DOWNLOAD_URL: opts.downloadUrl } as unknown as AppEnv['Bindings']
  return { app, validateInvite, checkRateLimit, get: (path: string, headers?: Record<string, string>) => app.request(path, { headers }, env) }
}

describe('GET /onboarding?code=', () => {
  it('renders the page for a valid invite, with nothing that identifies the service', async () => {
    const { get } = createApp()
    const res = await get(`https://hub.example.test/onboarding?code=${CODE}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    // The valid page actually says what to do — otherwise "no identifying string" is vacuous.
    expect(body).toContain('Open in app')
    expect(body).toContain(`/onboarding/open?code=${CODE}`)
    expect(body).toContain('<svg')
    for (const pattern of IDENTIFYING) expect(body).not.toMatch(pattern)
    // Nothing from the invite row leaks into the page.
    expect(body).not.toContain('Volunteer')
    expect(body).not.toContain('role-')
    // No scheme, no og/twitter preview metadata, no script.
    expect(body).not.toContain('://hub-invite')
    expect(body).not.toMatch(/<meta[^>]+(property|name)="(og:|twitter:|description)/i)
    expect(body).not.toContain('<script')
    expect(body).toContain('<title>Invitation</title>')
  })

  it('answers the same neutral page whatever made the token unusable', async () => {
    const reasons = ['not_found', 'already_used', 'expired']
    const bodies = new Set<string>()
    for (const error of reasons) {
      const { get } = createApp({ validate: { valid: false, error } })
      const res = await get(`https://hub.example.test/onboarding?code=${CODE}`)
      expect(res.status).toBe(404)
      const body = await res.text()
      expect(body).toContain('This link cannot be used')
      // The error code is never echoed; the copy names every cause at once ("not valid or has expired").
      for (const reason of ['not_found', 'already_used']) expect(body).not.toContain(reason)
      for (const pattern of IDENTIFYING) expect(body).not.toMatch(pattern)
      bodies.add(body)
    }
    expect(bodies.size).toBe(1)
  })

  it('renders that same page for a malformed code without looking anything up', async () => {
    const { get, validateInvite, checkRateLimit } = createApp()
    const res = await get('https://hub.example.test/onboarding?code=not-a-code')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('This link cannot be used')
    const missing = await get('https://hub.example.test/onboarding')
    expect(missing.status).toBe(404)
    expect(validateInvite).not.toHaveBeenCalled()
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('shares the invite-validate rate-limit bucket with the API validator', async () => {
    const { get, checkRateLimit, validateInvite } = createApp()
    await get(`https://hub.example.test/onboarding?code=${CODE}`)
    expect(checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: expect.stringMatching(/^invite-validate:/), maxPerMinute: 5 }))
    expect(validateInvite).toHaveBeenCalledOnce()
  })

  it('refuses to validate once the client is rate limited, in the same shell', async () => {
    const { get, validateInvite } = createApp({ limited: true })
    const res = await get(`https://hub.example.test/onboarding?code=${CODE}`)
    expect(res.status).toBe(429)
    const body = await res.text()
    expect(body).toContain('Too many attempts')
    expect(body).not.toContain('Open in app')
    for (const pattern of IDENTIFYING) expect(body).not.toMatch(pattern)
    expect(validateInvite).not.toHaveBeenCalled()
  })

  it('is never cached, framed, or allowed to run script, and sends no referrer', async () => {
    const { get } = createApp()
    const res = await get(`https://hub.example.test/onboarding?code=${CODE}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('offers a download link only when the operator configured one', async () => {
    const withLink = await (await createApp({ downloadUrl: 'https://downloads.example.test/app' }).get(`https://h.test/onboarding?code=${CODE}`)).text()
    expect(withLink).toContain('href="https://downloads.example.test/app"')
    expect(withLink).toContain('Get the app')
    // Unset is a supported deployment: the page still works, with "Open in app" alone.
    const none = await (await createApp().get(`https://h.test/onboarding?code=${CODE}`)).text()
    expect(none).toContain('Open in app')
    expect(none).not.toContain('Get the app')
  })

  it('never renders a download URL that is not absolute https', async () => {
    // Startup refuses these (lib/config.ts); the route must not emit one as an href even so.
    for (const bad of ['http://downloads.example.test/app', 'javascript:alert(1)', '/download']) {
      const res = await createApp({ downloadUrl: bad }).get(`https://h.test/onboarding?code=${CODE}`)
      expect(res.status).toBe(500)
      expect(await res.text()).not.toContain(bad)
    }
  })

  it('renders in the requested language, right to left where the script requires it', async () => {
    const { get } = createApp()
    const es = await (await get(`https://h.test/onboarding?code=${CODE}`, { 'Accept-Language': 'es-MX,es;q=0.9' })).text()
    expect(es).toContain('lang="es"')
    expect(es).toContain('Abrir en la aplicación')
    const ar = await (await get(`https://h.test/onboarding?code=${CODE}`, { 'Accept-Language': 'ar' })).text()
    expect(ar).toContain('dir="rtl"')
  })
})

describe('GET /onboarding/open', () => {
  it('redirects any well-formed code to the app deep link, whether or not it was ever issued', async () => {
    const { get, validateInvite } = createApp({ validate: { valid: false, error: 'not_found' } })
    const res = await get(`https://hub.example.test/onboarding/open?code=${CODE}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`llamenos://hub-invite?code=${CODE}`)
    expect(validateInvite).not.toHaveBeenCalled()
  })

  it('does not redirect a malformed code', async () => {
    const { get } = createApp()
    const res = await get('https://hub.example.test/onboarding/open?code=%0d%0aSet-Cookie:x')
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('pickLocale', () => {
  it('honours q-values and falls back to English', () => {
    expect(pickLocale('fr;q=0.4, de;q=0.8')).toBe('de')
    expect(pickLocale('xx-YY')).toBe('en')
    expect(pickLocale(undefined)).toBe('en')
    expect(pickLocale('fr;q=0')).toBe('en')
  })
})

describe('invitePage locale strings', () => {
  it('exist in every locale and none names the product', () => {
    const keys = Object.keys((locales.en.invitePage as Record<string, string>))
    for (const lang of LANGUAGE_CODES) {
      const page = locales[lang].invitePage as Record<string, string>
      for (const key of keys) {
        expect(page[key], `${lang}.invitePage.${key}`).toBeTruthy()
        for (const pattern of IDENTIFYING) expect(page[key]).not.toMatch(pattern)
      }
    }
  })
})
