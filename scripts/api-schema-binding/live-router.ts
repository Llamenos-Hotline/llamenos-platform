#!/usr/bin/env bun
/**
 * live-router.ts — print the routes the real Hono app registers, as a JSON
 * array of `METHOD /path`. The contract guard reads routes statically (so it
 * needs no database, no native crypto library and no codegen); this is how
 * that static table is proven complete.
 *
 * `app.ts` pulls in `packages/crypto/ffi.ts`, which `dlopen`s a native library
 * at import. Nothing runs at import time except route registration, so the FFI
 * module is replaced with throwing stubs of the same export names.
 */
import { plugin } from 'bun'
import { resolve } from 'node:path'

plugin({
  name: 'stub-crypto-ffi',
  setup(build) {
    build.onLoad({ filter: /packages\/crypto\/ffi\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const names = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map(m => m[1])
      return {
        loader: 'js',
        contents: names.map(n => `export const ${n} = () => { throw new Error('crypto ffi is stubbed in live-router.ts') }`).join('\n'),
      }
    })
  },
})

const app = (await import(resolve(import.meta.dirname, '../../apps/worker/app.ts'))).default as { routes: { method: string; path: string }[] }
console.log(JSON.stringify(app.routes.map(r => `${r.method} ${r.path}`)))
process.exit(0)
