# Epic 237: iOS Build Pipeline on Local Mac M4

## Goal

Establish a complete iOS build and test pipeline on the local Mac M4 (192.168.50.243), enabling:
1. UniFFI XCFramework builds (unblocking Epic 214 iOS)
2. iOS app compilation and unit testing
3. XCUITest execution on simulator
4. BDD test expansion (unblocking Epics 227 and 234)

## Context

The architecture audit (2026-03-03) identified that iOS crypto and testing have been blocked on macOS availability. A Mac mini M4 (16GB, macOS 26.2 Tahoe) is now on the local network and accessible via `ssh mac`.

**Current state on Mac M4:**
- Xcode CLT 26.3 installed
- Homebrew, asdf, Rust 1.93.1 installed
- iOS cross-compile targets: `aarch64-apple-ios`, `aarch64-apple-ios-sim`
- Repo cloned at `~/projects/llamenos` (desktop branch)
- Git configured with `riseup` SSH key for push access
- **Xcode full install**: In progress (needed for iOS SDK + simulators)

**Blocked epics unblocked by this work:**
- **Epic 214 (iOS)**: UniFFI XCFramework build + CryptoService.swift linkage
- **Epic 227**: iOS BDD E2E foundation (XCUITest with BDD naming)
- **Epic 234**: iOS BDD test expansion (76 → 200+ tests)

## Implementation

### Phase 1: XCFramework Build (Unblocks Epic 214 iOS)

Once Xcode is installed:

```bash
ssh mac 'cd ~/projects/llamenos && \
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer && \
  sudo xcodebuild -license accept && \
  bash packages/crypto/scripts/build-mobile.sh ios'
```

**Expected output:**
- `packages/crypto/dist/ios/LlamenosCoreFFI.xcframework/`
- `packages/crypto/dist/ios/LlamenosCore.swift`
- `packages/crypto/dist/ios/LlamenosCoreFFI.h`
- `packages/crypto/dist/ios/LlamenosCoreFFI.modulemap`

**Integration steps:**
1. Copy XCFramework to `apps/ios/LlamenosCoreFFI.xcframework/`
2. Update `apps/ios/Package.swift` with `.binaryTarget(name: "LlamenosCoreFFI", path: "...")`
3. Remove `#if !canImport(LlamenosCore)` stand-in block from `CryptoService.swift`
4. Add `import LlamenosCore` at top
5. Verify: `ssh mac 'cd ~/projects/llamenos/apps/ios && swift build'`

### Phase 2: iOS App Build & Test

#### 2.1 Swift Build
```bash
ssh mac 'cd ~/projects/llamenos/apps/ios && swift build'
```

#### 2.2 Unit Tests
```bash
ssh mac 'cd ~/projects/llamenos/apps/ios && swift test'
```

Key test files:
- `Tests/CryptoServiceTests.swift` — 20+ tests (will run against REAL crypto now)
- `Tests/KeychainServiceTests.swift` — 17+ tests

#### 2.3 Simulator Setup
```bash
ssh mac 'xcrun simctl list devices available | grep iPhone'
# Boot a simulator
ssh mac 'xcrun simctl boot "iPhone 16"'
```

#### 2.4 XCUITest Execution
```bash
ssh mac 'cd ~/projects/llamenos/apps/ios && \
  xcodebuild test \
    -scheme Llamenos \
    -destination "platform=iOS Simulator,name=iPhone 16" \
    -resultBundlePath TestResults.xcresult'
```

### Phase 3: Remote Build Script

Create `scripts/ios-build.sh` for convenient remote builds from the Linux dev machine:

```bash
#!/usr/bin/env bash
# Build and test iOS app on Mac M4 over SSH
set -euo pipefail

MAC_HOST="mac"
REMOTE_DIR="~/projects/llamenos"
ACTION="${1:-test}"  # build | test | xcframework | all

case "$ACTION" in
  xcframework)
    ssh $MAC_HOST "cd $REMOTE_DIR && bash packages/crypto/scripts/build-mobile.sh ios"
    ;;
  build)
    ssh $MAC_HOST "cd $REMOTE_DIR/apps/ios && swift build"
    ;;
  test)
    ssh $MAC_HOST "cd $REMOTE_DIR/apps/ios && swift test"
    ;;
  uitest)
    ssh $MAC_HOST "cd $REMOTE_DIR/apps/ios && xcodebuild test \
      -scheme Llamenos \
      -destination 'platform=iOS Simulator,name=iPhone 16' \
      -resultBundlePath TestResults.xcresult"
    ;;
  all)
    $0 xcframework && $0 build && $0 test && $0 uitest
    ;;
esac
```

### Phase 4: Git Sync Workflow

Since both machines have the repo:

```bash
# On Linux: push changes
git push origin desktop

# On Mac: pull and build
ssh mac 'cd ~/projects/llamenos && git pull && swift build -C apps/ios'
```

Or use `rsync` for faster iteration (no commit needed):
```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='target' \
  ./ mac:~/projects/llamenos/
```

### Phase 5: CI Integration (Future)

When ready for CI, add a self-hosted macOS runner:
- Install `github-actions-runner` on the Mac M4
- Tag as `macos-self-hosted`
- Use in `ci.yml` for iOS jobs:
```yaml
ios-build:
  runs-on: [self-hosted, macos-self-hosted]
  steps:
    - uses: actions/checkout@v4
    - name: Build XCFramework
      run: bash packages/crypto/scripts/build-mobile.sh ios
    - name: Build iOS app
      run: cd apps/ios && swift build
    - name: Run tests
      run: cd apps/ios && swift test
```

## Verification

1. `packages/crypto/scripts/build-mobile.sh ios` produces valid XCFramework
2. `swift build` succeeds with real crypto linked
3. `swift test` passes all 37+ tests (unit + crypto)
4. XCUITest runs on simulator via `xcodebuild test`
5. `scripts/ios-build.sh all` works end-to-end from Linux
6. Git push/pull workflow keeps both machines in sync

## Dependencies

- Xcode full install on Mac M4 (in progress)
- Epic 214 (Mobile Crypto Integration) — iOS portion completes with this epic
- Epic 227 (iOS BDD E2E Foundation) — unblocked by simulator access
- Epic 234 (iOS BDD Test Expansion) — unblocked by simulator access

## Risk

- **Medium**: Xcode download is ~30GB, may take time
- **Low**: build-mobile.sh may need adjustments for Xcode 26.2/macOS Tahoe
- **Low**: SSH-based build workflow adds latency vs local builds
