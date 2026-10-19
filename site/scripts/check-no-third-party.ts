/**
 * Privacy gate for the marketing site: a visitor's browser must never contact a third party.
 *
 * A request from this site to Google (fonts), an analytics host or a CDN tells that party — and
 * anyone watching the connection — that this person loaded a crisis hotline's website. Run
 * against a built `dist/`:
 *
 *   bun scripts/check-no-third-party.ts            static: every built page + the CSP
 *   bun scripts/check-no-third-party.ts --browser  also load every page in Chromium and fail on
 *                                                  any request that leaves 127.0.0.1
 *
 * The static check is what `bun run deploy` runs before publishing. It asserts two things:
 *  1. no page references a third-party origin through a subresource (<link>, <script>, <img>,
 *     <iframe>, srcset, CSS url(), @import) — plain <a href> navigations are not requests;
 *  2. every page carries a CSP that *refuses* a third-party origin, so a future component cannot
 *     reintroduce the leak silently.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const dist = resolve(import.meta.dir, '..', 'dist');
const SITE_HOST = 'llamenos-hotline.com';

const failures: string[] = [];
const fail = (where: string, what: string) => failures.push(`${where}: ${what}`);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Same-origin if relative, protocol-relative to us, or an absolute URL on our own host. */
function isFirstParty(url: string): boolean {
  const u = url.trim();
  if (u === '' || u.startsWith('data:') || u.startsWith('#')) return true;
  if (/^(https?:)?\/\//i.test(u)) {
    try {
      const host = new URL(u.startsWith('//') ? `https:${u}` : u).hostname;
      return host === SITE_HOST || host === `www.${SITE_HOST}`;
    } catch {
      return false;
    }
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(u);
}

const SUBRESOURCE_LINK_RELS = /(stylesheet|preload|prefetch|modulepreload|preconnect|dns-prefetch|icon|manifest|apple-touch-icon|prerender)/i;

function subresourceUrls(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'\s>]+(?:\s+[^"'>]+)?)/i.exec(tag)?.[1] ?? '';
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (href !== undefined && SUBRESOURCE_LINK_RELS.test(rel)) urls.push(href);
  }
  for (const m of html.matchAll(/<(?:script|img|iframe|frame|embed|source|video|audio|track|input|object)\b[^>]*>/gi)) {
    for (const a of m[0].matchAll(/\b(?:src|data|poster)\s*=\s*["']([^"']*)["']/gi)) urls.push(a[1]);
    for (const a of m[0].matchAll(/\bsrcset\s*=\s*["']([^"']*)["']/gi)) {
      for (const cand of a[1].split(',')) urls.push(cand.trim().split(/\s+/)[0]);
    }
  }
  for (const m of html.matchAll(/<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/gi)) urls.push(m[1]);
  return urls.concat(cssUrls(html));
}

function cssUrls(css: string): string[] {
  const urls: string[] = [];
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) urls.push(m[1]);
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) urls.push(m[1]);
  return urls;
}

/** True when a CSP source list admits something other than 'self'/'none'/hashes/data:/wasm. */
function admitsThirdParty(sources: string): string | null {
  for (const s of sources.split(/\s+/).filter(Boolean)) {
    if (/^'(self|none|wasm-unsafe-eval|unsafe-inline|sha(256|384|512)-[^']+)'$/.test(s)) continue;
    if (s === 'data:') continue;
    return s;
  }
  return null;
}

function checkCsp(html: string, where: string) {
  const meta = /<meta\s+http-equiv="content-security-policy"\s+content="([^"]*)"/i.exec(html)?.[1];
  if (!meta) return fail(where, 'no <meta http-equiv="content-security-policy"> — third-party origins are not refused');
  const directives = new Map(
    meta.split(';').map(d => d.trim()).filter(Boolean).map(d => {
      const [name, ...rest] = d.split(/\s+/);
      return [name, rest.join(' ')] as const;
    }),
  );
  if (directives.get('default-src') !== "'none'") fail(where, `default-src must be 'none', got ${directives.get('default-src')}`);
  for (const [name, value] of directives) {
    if (name === 'base-uri' || name === 'form-action') continue;
    const bad = admitsThirdParty(value);
    if (bad) fail(where, `CSP ${name} admits ${bad}`);
  }
}

async function checkStatic() {
  const files = await walk(dist);
  const pages = files.filter(f => f.endsWith('.html'));
  const styles = files.filter(f => f.endsWith('.css'));
  if (pages.length === 0) throw new Error(`no built pages under ${dist} — run \`bun run build\` first`);

  for (const f of pages) {
    const html = await readFile(f, 'utf8');
    const where = relative(dist, f);
    // Pagefind ships its own UI pages/fragments; they are not documents a visitor loads.
    if (!where.startsWith('pagefind/')) checkCsp(html, where);
    for (const url of subresourceUrls(html)) {
      if (!isFirstParty(url)) fail(where, `third-party subresource ${url}`);
    }
  }
  for (const f of styles) {
    for (const url of cssUrls(await readFile(f, 'utf8'))) {
      if (!isFirstParty(url)) fail(relative(dist, f), `third-party CSS reference ${url}`);
    }
  }

  const headers = await readFile(join(dist, '_headers'), 'utf8').catch(() => '');
  if (!/frame-ancestors\s+'none'/.test(headers)) fail('_headers', "missing Content-Security-Policy frame-ancestors 'none'");

  console.log(`static: ${pages.length} pages, ${styles.length} stylesheets checked`);
}

async function checkBrowser() {
  const { chromium } = await import('playwright-core');
  const files = (await walk(dist)).filter(f => f.endsWith('.html')).filter(f => !relative(dist, f).startsWith('pagefind/'));

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path.endsWith('/')) path += 'index.html';
      for (const candidate of [path, `${path}.html`, `${path}/index.html`]) {
        const file = Bun.file(join(dist, candidate));
        if (candidate.startsWith('/') && (await file.exists()) && !candidate.endsWith('/')) return new Response(file);
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const external = new Map<string, Set<string>>();
  let requests = 0;
  context.on('request', req => {
    requests++;
    if (!req.url().startsWith(origin) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) {
      const page = req.frame()?.page().url() ?? '?';
      (external.get(req.url()) ?? external.set(req.url(), new Set()).get(req.url())!).add(page);
    }
  });
  const violations: string[] = [];
  try {
    for (const f of files) {
      const rel = relative(dist, f);
      const page = await context.newPage();
      page.on('console', m => {
        if (/content security policy|refused to/i.test(m.text())) violations.push(`${rel}: ${m.text()}`);
      });
      await page.goto(`${origin}/${rel}`, { waitUntil: 'networkidle' });
      await page.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  console.log(`browser: ${files.length} pages loaded, ${requests} requests, ${external.size} left 127.0.0.1`);
  for (const [url, pages] of external) fail('browser', `request to ${url} from ${[...pages].slice(0, 3).join(', ')}`);
  for (const v of violations) fail('browser', `CSP violation: ${v}`);
}

await checkStatic();
if (process.argv.includes('--browser')) await checkBrowser();

if (failures.length > 0) {
  console.error(`\n${failures.length} privacy failure(s):`);
  for (const f of failures.slice(0, 50)) console.error(`  - ${f}`);
  if (failures.length > 50) console.error(`  … and ${failures.length - 50} more`);
  process.exit(1);
}
console.log('OK: no third-party requests, and the CSP refuses them.');
