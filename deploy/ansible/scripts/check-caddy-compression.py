#!/usr/bin/env python3
"""Fail if any Caddy config compresses a response that is not a public static file.

Why this exists (#3018). The repo carries more than one Caddy config: the
Docker Compose ingress (deploy/docker/Caddyfile, Caddyfile.production) and the
Ansible templates (roles/llamenos-caddy/templates/caddy.j2 is what the Ansible
deploy renders, plus two older templates). Caddyfile.production compressed the
API origin while the deployed template did not, so whichever file a person read
taught them something false about the other path, and nothing noticed.

The rule, applied identically to EVERY Caddy config so the paths cannot drift:

  `encode` is permitted only in a site block that serves files from disk
  (`file_server`) and proxies nothing (`reverse_proxy` absent, including via
  an imported snippet).

A proxied response is produced per request by a backend. On the API origin it
can carry session tokens, WebAuthn challenges and sealed envelopes alongside
caller- or attacker-influenced content, and compressing that turns response
length into an oracle on the secret (the BREACH/CRIME class). A file read off
disk is the same public bytes for everyone, so compressing it leaks nothing.
The rule is per site block, not per `handle`, on purpose: a mixed site must be
split before it may compress, which fails closed.

Usage: check-caddy-compression.py [--root DIR] [--min N]
  --root  directory to search for Caddy configs (default: deploy/, from the
          repo root)
  --min   fewest configs that must be found, so a broken glob is an error and
          never a vacuous pass (default: 5)
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MIN = 5

JINJA_COMMENT = re.compile(r"\{#.*?#\}", re.DOTALL)
JINJA_STATEMENT = re.compile(r"\{%.*?%\}", re.DOTALL)
JINJA_EXPRESSION = re.compile(r"\{\{.*?\}\}", re.DOTALL)


@dataclass
class Block:
    """A top-level Caddyfile block: global options, a (snippet), or a site."""

    header: str
    line: int
    directives: list[tuple[str, int]] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)


def is_caddy_config(path: Path) -> bool:
    # templates/compose/caddy.j2 is the Compose project that RUNS Caddy (YAML),
    # not Caddyfile syntax.
    if path.parent.name == "compose":
        return False
    return path.name.startswith("Caddyfile") or path.name == "caddy.j2"


def find_configs(root: Path) -> list[Path]:
    skip = {"node_modules", ".git"}
    return sorted(
        p
        for p in root.rglob("*")
        if p.is_file() and not skip.intersection(p.parts) and is_caddy_config(p)
    )


def strip_jinja(text: str) -> str:
    """Remove Jinja so only Caddyfile syntax is left, keeping line numbers."""

    def blank(m: re.Match[str]) -> str:
        return "\n" * m.group(0).count("\n")

    text = JINJA_COMMENT.sub(blank, text)
    text = JINJA_STATEMENT.sub(blank, text)
    # An expression is a value (a hostname, an email); keep a token in its place.
    return JINJA_EXPRESSION.sub("JINJA", text)


def tokens(line: str) -> list[str]:
    """Caddyfile tokens on one line; a token starting with `#` begins a comment."""
    out: list[str] = []
    for tok in line.split():
        if tok.startswith("#"):
            break
        out.append(tok)
    return out


def parse(text: str) -> list[Block]:
    """Top-level blocks with every directive name inside them, at any depth.

    Caddyfile opens a block with a `{` that is the last token of a line and
    closes it with a `}` that is the only token on its line; braces inside a
    token (`{$API_DOMAIN}`, `{remote_host}`) are placeholders, not blocks.
    """
    blocks: list[Block] = []
    depth = 0
    current: Block | None = None
    for n, raw in enumerate(strip_jinja(text).splitlines(), start=1):
        toks = tokens(raw)
        if not toks:
            continue
        if toks == ["}"]:
            depth -= 1
            if depth < 0:
                raise ValueError(f"line {n}: unbalanced closing brace")
            if depth == 0:
                current = None
            continue
        opens = toks[-1] == "{"
        body = toks[:-1] if opens else toks
        if depth == 0:
            if not opens:
                raise ValueError(f"line {n}: top-level line outside any block: {raw.strip()!r}")
            current = Block(header=" ".join(body), line=n)
            blocks.append(current)
        else:
            assert current is not None
            if body:
                current.directives.append((body[0], n))
                if body[0] == "import" and len(body) > 1:
                    current.imports.append(body[1])
        if opens:
            depth += 1
    if depth != 0:
        raise ValueError("unbalanced braces: a block is never closed")
    return blocks


def directive_names(block: Block, snippets: dict[str, Block], seen: frozenset[str] = frozenset()) -> set[str]:
    names = {d for d, _ in block.directives}
    for name in block.imports:
        snippet = snippets.get(name)
        if snippet is not None and name not in seen:
            names |= directive_names(snippet, snippets, seen | {name})
    return names


def violations(path: Path, text: str) -> list[str]:
    blocks = parse(text)
    snippets = {b.header[1:-1]: b for b in blocks if b.header.startswith("(") and b.header.endswith(")")}
    sites = [b for b in blocks if b.header and not b.header.startswith("(")]
    original = text.splitlines()
    found: list[str] = []
    for site in sites:
        names = directive_names(site, snippets)
        if "encode" not in names:
            continue
        if "reverse_proxy" in names or "file_server" not in names:
            line = next(
                (n for d, n in site.directives if d == "encode"),
                # encode arrived through an imported snippet
                site.line,
            )
            what = "proxies a backend" if "reverse_proxy" in names else "serves no files from disk"
            found.append(
                f"{path}:{line}: site `{original[site.line - 1].strip().rstrip('{').strip()}` compresses responses but {what}. "
                "`encode` is allowed only on a site that serves public files with "
                "`file_server` and proxies nothing (#3018)."
            )
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path("deploy"))
    parser.add_argument("--min", type=int, default=DEFAULT_MIN, dest="minimum")
    args = parser.parse_args(argv)

    configs = find_configs(args.root) if args.root.is_dir() else []
    if len(configs) < args.minimum:
        print(
            f"Found only {len(configs)} Caddy config(s) under {args.root} (expected at least "
            f"{args.minimum}). The search is wrong, so this check would pass without checking anything.",
            file=sys.stderr,
        )
        for c in configs:
            print(f"  {c}", file=sys.stderr)
        return 2

    problems: list[str] = []
    for config in configs:
        try:
            problems += violations(config, config.read_text(encoding="utf-8"))
        except ValueError as e:
            print(f"{config}: cannot parse as a Caddyfile: {e}", file=sys.stderr)
            return 2

    print(f"Checked {len(configs)} Caddy config(s):")
    for c in configs:
        print(f"  {c}")
    if problems:
        for p in problems:
            print(f"::error::{p}")
        return 1
    print("OK: no Caddy site compresses a proxied or dynamic response")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
