#!/usr/bin/env bun
/**
 * Verify that every SHA-pinned `uses:` line under .github/ carries a trailing
 * `# <version>` comment that is TRUE — i.e. that the pinned commit really is
 * the commit the named tag (or ref) points at upstream.
 *
 *   uses: actions/download-artifact@3e5f45b2…  # v4.1.7     <- must be v4.1.7
 *
 * Why this exists (#2040): three call sites carried `# v4.1.7` on a SHA that
 * was actually v8.0.1. Nothing noticed, because no check ever compared a pin
 * comment to the thing it pinned. A pin whose comment lies is exactly the
 * signature a malicious bump would wear — reviewers read the comment, not the
 * 40 hex characters — so the comment is checked against upstream, not trusted.
 *
 * Resolution is `git ls-remote --tags --heads` — ONE call per distinct
 * upstream repo (~25 for ~260 pins), no REST rate limit, no token. Annotated
 * tags are dereferenced through their peeled `^{}` entry.
 *
 * Exit codes:
 *   0  every pin's comment matches upstream
 *   1  at least one pin's comment is wrong, missing, or names a ref that does
 *      not exist
 *   2  the lookup could not be performed (network, rate limit, repo gone).
 *      "Could not look" is NEVER "fine": this fails the job loudly.
 *
 * Comment forms:
 *   - exact version (`v4.1.7`, `4.1.7`): the tag must exist and resolve to the
 *     pinned SHA. Tags are treated as immutable.
 *   - moving ref (`v2`, `stable`, `main`): the ref must exist and the pinned SHA
 *     must be the ref's tip or an ancestor of it (GitHub compare API). Such a
 *     ref legitimately advances past the pin, so equality would go red on an
 *     unrelated upstream push.
 *   - no comment: rejected. An uncommented pin cannot be reviewed.
 *
 * Usage: bun .github/scripts/check-action-pins.ts [root ...]   (default: .github)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Pin {
  file: string;
  line: number;
  /** `owner/repo` — the action's subpath (`/analyze`) is not part of it. */
  repo: string;
  sha: string;
  /** First token of the trailing comment, or null when there is none. */
  ref: string | null;
}

export interface RepoRefs {
  /** tag name -> commit sha (annotated tags already dereferenced) */
  tags: Map<string, string>;
  /**
   * tag name -> the annotated tag OBJECT's sha. `uses: o/r@<tag-object-sha>`
   * resolves to the same commit, so it is an equally honest pin.
   */
  tagObjects: Map<string, string>;
  /** branch name -> tip commit sha */
  heads: Map<string, string>;
}

export type Verdict =
  | { kind: "ok" }
  | { kind: "bad"; message: string }
  /** Moving ref that has advanced past the pin: caller must prove ancestry. */
  | { kind: "ancestor-check"; ref: string };

const PIN_LINE = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"@]+)@([0-9a-f]{40})\1[ \t]*(?:#[ \t]*(\S+).*)?$/;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function parsePins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  text.split("\n").forEach((raw, i) => {
    const m = PIN_LINE.exec(raw.replace(/\r$/, ""));
    if (!m) return;
    const [owner, repo] = m[2].split("/");
    if (!owner || !repo) return;
    pins.push({ file, line: i + 1, repo: `${owner}/${repo}`, sha: m[3], ref: m[4] ?? null });
  });
  return pins;
}

export function parseLsRemote(output: string): RepoRefs {
  const tags = new Map<string, string>();
  const tagObjects = new Map<string, string>();
  const heads = new Map<string, string>();
  const peeled = new Set<string>();
  for (const row of output.split("\n")) {
    const [sha, ref] = row.split("\t");
    if (!sha || !ref) continue;
    if (ref.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
    else if (ref.startsWith("refs/tags/")) {
      const name = ref.slice("refs/tags/".length);
      if (name.endsWith("^{}")) {
        const bare = name.slice(0, -3);
        tags.set(bare, sha); // the commit an annotated tag points at
        peeled.add(bare);
      } else {
        tagObjects.set(name, sha);
        if (!peeled.has(name)) tags.set(name, sha); // lightweight tag (or the tag object, until peeled)
      }
    }
  }
  return { tags, tagObjects, heads };
}

const short = (sha: string) => sha.slice(0, 8);

const pinsTag = (refs: RepoRefs, name: string, sha: string) =>
  refs.tags.get(name) === sha || refs.tagObjects.get(name) === sha;

function tagsAt(refs: RepoRefs, sha: string): string[] {
  return [...refs.tags.keys()].filter((n) => pinsTag(refs, n, sha));
}

export function evaluate(pin: Pin, refs: RepoRefs): Verdict {
  const where = `${pin.repo}@${short(pin.sha)}`;
  if (pin.ref === null) {
    const real = tagsAt(refs, pin.sha);
    return {
      kind: "bad",
      message: `${where} has no trailing "# <version>" comment${
        real.length ? ` (this SHA is ${real.join(", ")})` : ""
      }; an uncommented pin cannot be reviewed`,
    };
  }
  if (EXACT_VERSION.test(pin.ref)) {
    const actual = refs.tags.get(pin.ref);
    if (pinsTag(refs, pin.ref, pin.sha)) return { kind: "ok" };
    const real = tagsAt(refs, pin.sha);
    const isNow = real.length ? `this SHA is actually ${real.join(", ")}` : "this SHA is not any release tag";
    return {
      kind: "bad",
      message:
        actual === undefined
          ? `${where} is commented "# ${pin.ref}" but ${pin.repo} has no such tag; ${isNow}`
          : `${where} is commented "# ${pin.ref}" but ${pin.ref} is ${short(actual)}; ${isNow}`,
    };
  }
  const tip = refs.tags.get(pin.ref) ?? refs.heads.get(pin.ref);
  if (tip === undefined) {
    return { kind: "bad", message: `${where} is commented "# ${pin.ref}" but ${pin.repo} has no such tag or branch` };
  }
  return tip === pin.sha || pinsTag(refs, pin.ref, pin.sha) ? { kind: "ok" } : { kind: "ancestor-check", ref: pin.ref };
}

function findYaml(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) findYaml(p, out);
    else if (/\.ya?ml$/.test(name)) out.push(p);
  }
  return out;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function lsRemote(repo: string): Promise<RepoRefs> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const proc = Bun.spawn(["git", "ls-remote", "--tags", "--heads", `https://github.com/${repo}.git`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => proc.kill(), 90_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const refs = code === 0 ? parseLsRemote(out) : null;
    // An empty answer for a repo that has pins is a failed lookup, not "no tags".
    if (refs && (refs.tags.size > 0 || refs.heads.size > 0)) return refs;
    lastErr = code === 0 ? "empty ref list" : `git ls-remote exit ${code}: ${err.trim().slice(0, 300)}`;
    if (attempt < 3) await sleep(attempt * 2000);
  }
  throw new Error(`${repo}: ${lastErr}`);
}

/** GET a GitHub REST path. Returns the parsed body, or null on 404; throws on anything else. */
async function ghApi<T>(path: string, what: string): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "llamenos-check-action-pins",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200) return (await res.json()) as T;
      if (res.status === 404) return null;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e);
    }
    if (attempt < 3) await sleep(attempt * 2000);
  }
  throw new Error(`${what} failed (${lastErr})`);
}

/**
 * True when `sha` is the ref tip or an ancestor of it. Throws if it cannot tell.
 * `sha` may be an annotated tag object (e.g. an earlier incarnation of a moving
 * `v2` tag): it is peeled to its commit first.
 */
async function isAncestorOfRef(repo: string, sha: string, ref: string): Promise<boolean> {
  let commit = sha;
  const tagObj = await ghApi<{ object?: { sha?: string; type?: string } }>(
    `repos/${repo}/git/tags/${sha}`,
    `${repo}: git/tags/${short(sha)}`,
  );
  if (tagObj?.object?.type === "commit" && tagObj.object.sha) commit = tagObj.object.sha;
  const cmp = await ghApi<{ status?: string }>(
    `repos/${repo}/compare/${commit}...${encodeURIComponent(ref)}`,
    `${repo}: compare ${short(commit)}...${ref}`,
  );
  // `ahead`/`identical`: ref is at or beyond the commit. `behind`/`diverged`: it is NOT in ref's history.
  // null (404): the commit is unknown to the repo — an imposter/fork commit.
  return cmp?.status === "ahead" || cmp?.status === "identical";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

function annotate(level: "error", file: string, line: number, msg: string) {
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::${level} file=${file},line=${line},title=Pinned action comment::${msg}`);
  else console.error(`${file}:${line}: ${msg}`);
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) roots.push(".github");
  const pins = roots
    .flatMap((r) => findYaml(r))
    .sort()
    .flatMap((f) => parsePins(readFileSync(f, "utf8"), f));
  if (pins.length === 0) {
    // A guard that found nothing to check has not checked anything.
    console.error(`check-action-pins: found 0 SHA-pinned "uses:" lines under ${roots.join(", ")} — refusing to pass vacuously`);
    process.exit(2);
  }

  const repos = [...new Set(pins.map((p) => p.repo))].sort();
  const refsByRepo = new Map<string, RepoRefs>();
  const lookupErrors: string[] = [];
  await mapLimit(repos, 6, async (repo) => {
    try {
      refsByRepo.set(repo, await lsRemote(repo));
    } catch (e) {
      lookupErrors.push((e as Error).message);
    }
  });
  if (lookupErrors.length) {
    console.error("check-action-pins: COULD NOT VERIFY — upstream lookup failed. This is a failure, not a pass:");
    for (const e of lookupErrors) console.error(`  - ${e}`);
    process.exit(2);
  }

  const problems: Array<{ pin: Pin; message: string }> = [];
  const pending: Array<{ pin: Pin; ref: string }> = [];
  for (const pin of pins) {
    const refs = refsByRepo.get(pin.repo);
    if (!refs) throw new Error(`no upstream refs loaded for ${pin.repo}`); // unreachable: lookup errors exit above
    const v = evaluate(pin, refs);
    if (v.kind === "bad") problems.push({ pin, message: v.message });
    else if (v.kind === "ancestor-check") pending.push({ pin, ref: v.ref });
  }

  const ancestry = new Map<string, boolean>();
  try {
    const uniq = [...new Map(pending.map((p) => [`${p.pin.repo}|${p.pin.sha}|${p.ref}`, p])).values()];
    await mapLimit(uniq, 4, async ({ pin, ref }) => {
      ancestry.set(`${pin.repo}|${pin.sha}|${ref}`, await isAncestorOfRef(pin.repo, pin.sha, ref));
    });
  } catch (e) {
    console.error(`check-action-pins: COULD NOT VERIFY — ${(e as Error).message}. This is a failure, not a pass.`);
    process.exit(2);
  }
  for (const { pin, ref } of pending) {
    if (!ancestry.get(`${pin.repo}|${pin.sha}|${ref}`)) {
      problems.push({
        pin,
        message: `${pin.repo}@${short(pin.sha)} is commented "# ${ref}" but is not in ${ref}'s history`,
      });
    }
  }

  problems.sort((a, b) => a.pin.file.localeCompare(b.pin.file) || a.pin.line - b.pin.line);
  for (const { pin, message } of problems) annotate("error", pin.file, pin.line, message);
  if (problems.length) {
    console.error(`\ncheck-action-pins: ${problems.length} of ${pins.length} pinned actions have a comment that does not match upstream.`);
    process.exit(1);
  }
  console.log(`check-action-pins: ${pins.length} pinned actions across ${repos.length} repos — every version comment matches upstream`);
}

if (import.meta.main) await main();
