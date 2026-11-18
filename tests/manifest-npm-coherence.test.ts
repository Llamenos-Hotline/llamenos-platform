// @suite: repo
// Rail for the class of bug fixed alongside this test: a root `overrides` entry
// that disagrees with a same-named direct `dependencies`/`devDependencies` entry.
//
// bun accepts that mismatch silently — every bun-based CI job (typecheck, unit,
// integration, BDD, `bun install --frozen-lockfile`) stays green. The mismatch only
// surfaces when something shells out to real npm, which is exactly what the release
// job's SBOM step does (`npx --yes @cyclonedx/cdxgen`). npm calls it `EOVERRIDE` and
// hard-fails:
//
//   npm error code EOVERRIDE
//   npm error Override for hono@^4.13.8 conflicts with direct dependency
//
// This happened for real: #922 bumped `dependencies.hono` to `^4.13.8` to land the
// GHSA-88fw-hqm2-52qc fix, and added `overrides.hono = ">=4.12.25"` to dedupe a
// transitive copy. bun was fine with the pair; npm was not, and the release pipeline's
// "Generate CycloneDX SBOM" step failed even though every bun-based check on the same
// commit was green. This test runs under `bun test`, i.e. in ordinary CI, so that class
// of drift is caught long before a release run reaches the npm-only step.
//
// Verified empirically against real npm (see PR description): when a package name
// appears in BOTH `overrides` and a direct dependency map at the top level, npm
// requires the two version specifiers to be byte-identical strings — not merely
// semver-compatible or one a subset of the other. A narrower, still-compatible range
// (e.g. direct `^4.13.8` vs override `^4.13.9`) still trips EOVERRIDE. So the rail
// below checks for exact string equality, matching npm's actual behavior rather than
// a looser semver-overlap approximation that would pass cases npm still rejects.
import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

function readManifest(): PackageManifest {
  const raw = readFileSync(join(ROOT, "package.json"), "utf-8");
  return JSON.parse(raw) as PackageManifest;
}

describe("root package.json is coherent under npm", () => {
  test("no override conflicts with a direct dependency of the same name", () => {
    const manifest = readManifest();
    const overrides = manifest.overrides ?? {};
    const direct = { ...manifest.dependencies, ...manifest.devDependencies };

    const conflicts: string[] = [];
    for (const [name, overrideRange] of Object.entries(overrides)) {
      const directRange = direct[name];
      if (directRange === undefined) {
        // Not also a direct dependency — npm has no opinion, this is the common case
        // (e.g. dedupe-only overrides for purely transitive packages).
        continue;
      }
      if (directRange !== overrideRange) {
        conflicts.push(
          `"${name}": overrides="${overrideRange}" vs direct="${directRange}" ` +
            `(npm requires these to be identical strings when both are present)`,
        );
      }
    }

    if (conflicts.length > 0) {
      throw new Error(
        `package.json has ${conflicts.length} npm-incoherent override(s):\n` +
          conflicts.map((c) => `  - ${c}`).join("\n") +
          `\n\nThis is invisible to bun but breaks 'npm install' / 'npx <tool>' with ` +
          `EOVERRIDE (e.g. the release job's CycloneDX SBOM step). Either make the ` +
          `override string identical to the direct dependency's specifier, or remove ` +
          `the override if resolution already converges without it (verify with ` +
          `'bun pm why <package>').`,
      );
    }
  });
});
