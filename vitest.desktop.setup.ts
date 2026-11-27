import { afterAll, afterEach } from 'vitest'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './packages/i18n/locales/en.json'

// Initialize i18n synchronously with English translations for all desktop unit tests.
// Without this, t('some.key') returns the raw key string instead of the translated text,
// breaking any test that asserts on user-visible strings.
if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: en },
    },
  })
}

// ── No network (#3084) ─────────────────────────────────────────────────
//
// A desktop unit test must never reach a real socket. happy-dom resolves a
// relative URL against `http://localhost:3000` and its `fetch` then really
// connects there — so a provider that fetches on mount talked to whatever
// happened to be listening on that port (a contributor's dev server, another
// worker's backend), and passed or failed on what it read. With nothing
// listening it failed quietly into the caller's error path instead, which is
// why the leak stayed invisible: an error a caller catches is not a failure.
//
// So egress is refused here and every attempt is recorded, and a test that
// made one FAILS in `afterEach` — whether or not the code under test swallowed
// the rejection. A test that needs a network double installs it with
// `vi.stubGlobal('fetch' | 'WebSocket' | 'XMLHttpRequest', …)`; the stub
// replaces this guard for that test and `vi.unstubAllGlobals()` restores it.
// `data:` and `blob:` URLs open no socket and still go to happy-dom.

const egressAttempts: string[] = []

function refuseEgress(kind: string, target: string): Error {
  egressAttempts.push(`${kind} ${target}`)
  return new TypeError(
    `desktop unit tests have no network: refused ${kind} ${target}. ` +
    `Mock the module that issues it, or stub the global for this test.`,
  )
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(raw, location.href)
}

const happyDomFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input)
    if (url.protocol === 'data:' || url.protocol === 'blob:') return happyDomFetch(input, init)
    return Promise.reject(refuseEgress('fetch', url.href))
  },
  // `typeof fetch` carries Bun's `fetch.preconnect`, which opens a socket too.
  { preconnect: (url: string | URL): void => { throw refuseEgress('preconnect', requestUrl(url).href) } },
)

globalThis.WebSocket = new Proxy(WebSocket, {
  construct(_target, [url]: ConstructorParameters<typeof WebSocket>) {
    throw refuseEgress('WebSocket', new URL(url, location.href).href)
  },
})

class NoNetworkXMLHttpRequest extends XMLHttpRequest {
  override open(method: string, url: string | URL): void {
    throw refuseEgress(`XMLHttpRequest ${method}`, new URL(url, location.href).href)
  }
}
globalThis.XMLHttpRequest = NoNetworkXMLHttpRequest

function failOnEgress(when: string): void {
  if (egressAttempts.length === 0) return
  const attempts = egressAttempts.splice(0)
  throw new Error(
    `${when} attempted ${attempts.length} real network connection(s) — ` +
    `desktop unit tests must be isolated from whatever is listening locally:\n  ` +
    attempts.join('\n  '),
  )
}

afterEach(() => failOnEgress('this test'))
afterAll(() => failOnEgress('this file (after its last test)'))
