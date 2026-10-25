import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A font fetch on launch tells an outside party the volunteer's IP and launch times (#2222).
const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

describe("desktop shell fonts are self-hosted", () => {
  const sources = ["index.html", "src/client/app.css", "src/client/styles/fonts.css"];

  it.each(sources)("%s references no remote origin", (rel) => {
    expect(read(rel)).not.toMatch(/https?:\/\/|\/\/fonts\./);
  });

  it("every @font-face src is a bundled relative file", () => {
    const urls = [...read("src/client/styles/fonts.css").matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\.\/fonts\/[\w-]+\.woff2$/);
  });

  it("ships the OFL licence alongside the font files", () => {
    expect(read("src/client/styles/fonts/OFL.txt")).toContain("SIL Open Font License");
  });
});
