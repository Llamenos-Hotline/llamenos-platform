/**
 * The page an https invite link opens in a browser (#2385).
 *
 * `https://<hub>/onboarding?code=<uuid>` is what an admin sends a person who
 * does not have the app yet, so the first thing it has to do is work in a
 * browser. It is also seen by people it was never meant for — a mail provider,
 * an SMS carrier, a messenger that renders a link preview before anyone taps,
 * whoever holds the device — so it is UNBRANDED by construction: no hub, no
 * organisation, no logo, no product name, nothing in `<title>`, meta tags or
 * an OpenGraph preview. It confirms the link is usable and says what to do
 * next, and nothing else.
 *
 * Validity is checked server-side before rendering, so an expired link does
 * not send anyone off to install an app for nothing. A link that does not
 * validate — never issued, already used, expired — renders the same neutral
 * page, so the page is no oracle for which of those it was.
 * `inviteValidationResponseSchema` deliberately carries no hub field, and this
 * page reads none: it uses only `valid`.
 *
 * Validation is unauthenticated and token-shaped, so it is rate limited in the
 * SAME bucket as `GET /api/invites/validate/:code` (`invite-validate`): both
 * routes together answer a client at most 5 times a minute, and neither is a
 * way around the other's limit.
 *
 * The "Open in app" button points at `/onboarding/open`, which redirects to the
 * app's deep link. The deep-link scheme names the product, so it is kept out
 * of the page itself — it is disclosed only to a person who pressed the button,
 * never to a preview bot or a scanner of the page body.
 */

import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { getLocaleString, LANGUAGE_CODES, DEFAULT_LANGUAGE } from '@llamenos/i18n'
import type { AppEnv } from '../types'
import { checkRateLimit } from '../lib/helpers'
import { routeRateLimitClient } from '../lib/route-rate-limit'
import { parseAppDownloadUrl } from '../lib/config'

/** Invite codes are `crypto.randomUUID()` — the same shape `normalizeInviteCode` accepts client-side. */
const INVITE_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The app's deep-link scheme and invite host (apps/desktop/src/deep_link.rs). */
const DEEP_LINK_PREFIX = 'llamenos://hub-invite?code='

/** Scripts that read right to left. */
const RTL_LOCALES = new Set(['ar', 'fa'])

const STYLE = `
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#111}
main{max-width:24rem;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 1rem}
a.button{display:inline-block;margin:.25rem;padding:.75rem 1.5rem;border-radius:.5rem;background:#111;color:#fff;text-decoration:none}
a.secondary{background:#fff;color:#111;border:1px solid #111}
svg{margin-top:1.5rem;max-width:100%;height:auto}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a.button{background:#eee;color:#111}a.secondary{background:#111;color:#eee;border-color:#eee}svg{background:#fff;padding:.5rem}}
`

/** The page ships no script and exactly one stylesheet, which the policy names by hash. */
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64')
const CONTENT_SECURITY_POLICY =
  `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

type PageKind = 'valid' | 'invalid' | 'rateLimited'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

/** The best supported locale in an `Accept-Language` header; English when none matches. */
export function pickLocale(acceptLanguage: string | undefined): string {
  const requested = (acceptLanguage ?? '')
    .split(',')
    .map(part => {
      const [tag, ...params] = part.trim().split(';')
      const q = params.map(p => p.trim()).find(p => p.startsWith('q='))
      return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1 }
    })
    .filter(r => r.lang && Number.isFinite(r.q) && r.q > 0)
    .sort((a, b) => b.q - a.q)
  return requested.find(r => LANGUAGE_CODES.includes(r.lang))?.lang ?? DEFAULT_LANGUAGE
}

/** A string from `invitePage.*`, in `locale` or else English. Every key exists in en.json. */
function text(locale: string, key: string): string {
  const full = `invitePage.${key}`
  const value = getLocaleString(locale, full) ?? getLocaleString(DEFAULT_LANGUAGE, full)
  if (value === undefined) throw new Error(`Missing locale key ${full}`)
  return value
}

export interface InvitePageInput {
  kind: PageKind
  locale: string
  /** The invite code, for the "Open in app" link and the QR code. Only for `valid`. */
  code?: string
  /** This page's own URL, which the QR code carries so a phone can scan it from a desktop screen. */
  pageUrl?: string
  /** Where the client can be installed from, when the operator configured one. */
  downloadUrl?: string
}

/** The whole document. Nothing in it comes from the hub, the invite row, or the product's name. */
export function renderInvitePage({ kind, locale, code, pageUrl, downloadUrl }: InvitePageInput): string {
  const t = (key: string) => escapeHtml(text(locale, key))
  const parts: string[] = []
  if (kind === 'valid' && code) {
    parts.push(`<h1>${t('validHeading')}</h1><p>${t('validBody')}</p>`)
    parts.push(`<a class="button" href="/onboarding/open?code=${encodeURIComponent(code)}">${t('openInApp')}</a>`)
    if (downloadUrl) {
      parts.push(`<a class="button secondary" href="${escapeHtml(downloadUrl)}" rel="noreferrer noopener">${t('downloadApp')}</a>`)
    }
    if (pageUrl) {
      parts.push(renderToStaticMarkup(createElement(QRCodeSVG, { value: pageUrl, size: 192, title: t('qrLabel') })))
    }
  } else if (kind === 'rateLimited') {
    parts.push(`<h1>${t('rateLimitedHeading')}</h1><p>${t('rateLimitedBody')}</p>`)
  } else {
    parts.push(`<h1>${t('invalidHeading')}</h1><p>${t('invalidBody')}</p>`)
  }

  const dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${t('title')}</title>
<style>${STYLE}</style>
</head>
<body><main>${parts.join('')}</main></body>
</html>`
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
} as const

const invitePage = new Hono<AppEnv>()

invitePage.get('/', async (c) => {
  const locale = pickLocale(c.req.header('Accept-Language'))
  const respond = (kind: PageKind, status: 200 | 404 | 429, extra?: Pick<InvitePageInput, 'code' | 'pageUrl' | 'downloadUrl'>) =>
    c.body(renderInvitePage({ kind, locale, ...extra }), status, PAGE_HEADERS)

  // A malformed code can never have been issued: say so without spending a lookup.
  const code = (c.req.query('code') ?? '').toLowerCase()
  if (!INVITE_CODE.test(code)) return respond('invalid', 404)

  const services = c.get('services')
  if (await checkRateLimit(services.settings, `invite-validate:${routeRateLimitClient(c)}`, 5)) {
    return respond('rateLimited', 429)
  }

  const { valid } = await services.identity.validateInvite(code)
  if (!valid) return respond('invalid', 404)

  const url = new URL(c.req.url)
  return respond('valid', 200, {
    code,
    pageUrl: `${url.origin}${url.pathname}?code=${encodeURIComponent(code)}`,
    // Unset: no download link. Malformed never reaches here — startup refuses it.
    downloadUrl: parseAppDownloadUrl(c.env.APP_DOWNLOAD_URL),
  })
})

// The "Open in app" target. Any well-formed code gets the same redirect — the
// app validates the invite itself — so this answers nothing about a token.
invitePage.get('/open', (c) => {
  const code = (c.req.query('code') ?? '').toLowerCase()
  if (!INVITE_CODE.test(code)) {
    const locale = pickLocale(c.req.header('Accept-Language'))
    return c.body(renderInvitePage({ kind: 'invalid', locale }), 404, PAGE_HEADERS)
  }
  return c.redirect(`${DEEP_LINK_PREFIX}${encodeURIComponent(code)}`, 302)
})

export default invitePage
