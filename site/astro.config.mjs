import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import pagefind from 'astro-pagefind';

export default defineConfig({
  output: 'static',
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: 'en',
          es: 'es',
          zh: 'zh-Hans',
          tl: 'tl',
          vi: 'vi',
          ar: 'ar',
          fr: 'fr',
          ht: 'ht',
          ko: 'ko',
          ru: 'ru',
          hi: 'hi',
          pt: 'pt',
          de: 'de',
          uk: 'uk',
          fa: 'fa',
          tr: 'tr',
          ku: 'ku',
          so: 'so',
          am: 'am',
          my: 'my',
          quc: 'quc',
          mix: 'mix',
        },
      },
    }),
    pagefind(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  // A visitor's browser must never contact a third party: a request to Google Fonts, an analytics
  // host or a CDN tells that party (and anyone watching the connection) that this person loaded a
  // crisis hotline's site. Astro emits this as a <meta> CSP with per-page script/style hashes, so
  // any third-party origin a future component adds is REFUSED by the browser, not merely unused.
  // The header-only directives (frame-ancestors etc.) live in public/_headers. `check-privacy`
  // (scripts/check-no-third-party.ts) asserts both stay in force.
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
      ],
      styleDirective: {
        // Shiki-highlighted code blocks carry style="" attributes; hashes cannot cover those.
        resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }],
      },
      scriptDirective: {
        // Pagefind loads its search index as WebAssembly.
        resources: ["'self'", "'wasm-unsafe-eval'"],
      },
    },
  },
  site: 'https://llamenos-hotline.com',
  i18n: {
    locales: ['en', 'es', 'zh', 'tl', 'vi', 'ar', 'fr', 'ht', 'ko', 'ru', 'hi', 'pt', 'de', 'uk', 'fa', 'tr', 'ku', 'so', 'am', 'my', 'quc', 'mix'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
