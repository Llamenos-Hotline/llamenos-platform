# Desktop Build Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | 1.85+ | [rustup.rs](https://rustup.rs) |
| Bun | latest | [bun.sh](https://bun.sh) |
| Tauri CLI | 2.x | `bun install` (included as devDep) |

### Linux (Debian/Ubuntu)

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

### macOS

```bash
xcode-select --install
```

### Windows

Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-studio-build-tools/) with "Desktop development with C++".

## Setup

```bash
# Clone the monorepo
git clone git@github.com:Llamenos-Hotline/llamenos-platform.git

# Install dependencies
cd llamenos-platform
bun install

# Or use the setup script
./scripts/dev-setup.sh
```

The shared crypto crate lives in-repo at `packages/crypto/`. `apps/desktop/Cargo.toml` references it as a path dependency (`../../packages/crypto`) — no separate repo clone needed.

## Development

```bash
bun run tauri:dev
```

This starts:
1. Vite dev server (port 5173)
2. Rust compilation + Tauri window

Hot reloading works for the frontend. Rust changes require a restart.

## Release Build

```bash
bun run tauri:build
```

Outputs platform-specific installers to `apps/desktop/target/release/bundle/`.

## Type Checking

```bash
bun run typecheck
```

Always run before committing.

## Running E2E Tests

### Playwright (Web Mock)

Tests run against a mock IPC layer (no Rust backend):

```bash
bun run test              # Run all tests
bun run test:ui           # Playwright UI mode
bun run test -- --grep "smoke"  # Run specific tests
```

### Real Tauri app

To run the full desktop E2E suite against the real Tauri app:

```bash
bun run test:desktop
```

## Flatpak Build

```bash
flatpak-builder --user --install build-dir flatpak/org.llamenos.Hotline.yml
```

Requires `flatpak-builder` and GNOME Platform 47 runtime.

## Version Management

Versions are managed by **knope** — never edit `package.json`, `apps/desktop/tauri.conf.json`, or `Cargo.toml` version fields manually. knope keeps them in sync and maintains `CHANGELOG.md`.

```bash
# Bump version (updates package.json, tauri.conf.json, and CHANGELOG.md)
bun run version:bump patch "Bug fix release"
bun run version:bump minor "New feature"
bun run version:bump major "Breaking change"
```

The release PR (branch `release`) is created automatically by the `knope-release-pr.yml` workflow. Merging it to `main` triggers the full release pipeline.

## Troubleshooting

### Rust crypto crate not found

`packages/crypto/` is part of the monorepo — it is not a separate repo. If you see path dependency errors, ensure you are inside the `llamenos-platform` repo root and have run `bun install`.

### Rust compilation slow

First build compiles all dependencies (~5 min). Subsequent builds are incremental (~10s).

### WebKit not found (Linux)

Install the dev package for your distro. On Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev`.
