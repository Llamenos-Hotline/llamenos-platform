# Mobile Multi-Hub Background Services

**Date:** 2026-03-20
**Status:** Approved for implementation
**Priority:** P0 — users on shift in multiple hubs receive no calls or notifications from non-active hubs
**Depends on:** `2026-03-20-mobile-multi-hub-switching.md` (spec 1 — hub key infrastructure, HubContext/ActiveHubState)

---

## Problem Statement

Spec 1 (mobile-multi-hub-switching) establishes the UI active hub context and the `hp()` path helper. But active-hub switching alone is insufficient for multi-hub users: a volunteer on shift in Hub A and Hub B must receive calls, relay events, and push notifications from both hubs simultaneously — regardless of which hub is currently displayed in the UI.

Currently:
- Hub keys are loaded only for the active hub — relay events from other hubs cannot be decrypted
- `WakePayload` and `FullPushPayload` carry no `hubId` — the client cannot route an incoming notification to the correct hub
- Linphone is documented in Epic 91 but designed for React Native, which is not the app architecture. No native Linphone integration exists
- The relay WebSocket emits bare events with no hub attribution — consumers cannot distinguish which hub an event belongs to
- SIP registration (for VoIP calls) is not implemented on mobile at all

This spec implements the background layer: eager hub key loading, hub-attributed relay events, `hubId` in push payloads, per-hub activity indicators, and native Linphone integration for iOS (Swift) and Android (Kotlin).

---

## Architecture

### Two Parallel Layers

| Layer | Spec | Scope | Hub keys needed |
|---|---|---|---|
| UI / data browsing | Spec 1 | Active hub only | Active hub |
| Background services | This spec | All hubs simultaneously | All hubs |

The relay WebSocket connection remains single (one connection to strfry). All hub keys are cached eagerly at login. Each incoming relay event is decrypted by trying each cached hub key in turn — first success identifies the source hub. Hub membership is typically single digits, so O(n) per event is negligible.

### Approach: Eager Key Loading + Hub-Tagged Events

- At login: load hub keys for **all** hubs the user belongs to
- Relay events: try all cached keys, emit `(hubId, ProtocolHubEvent)` pairs
- Push payloads: carry `hubId` for routing
- SIP (Linphone): register one account per hub the user is on shift in; accounts added/removed on shift state changes
- VoIP push: `hubId` in payload stored against `callId`; accepting a call switches `activeHubId`

---

## Backend Changes

### 1. Add `hubId` to Push Payloads

`apps/worker/types/infra.ts` — add `hubId: string` to `WakePayload` and `FullPushPayload`:

```typescript
export interface WakePayload {
  hubId: string          // NEW — identifies which hub this push belongs to
  type: PushNotificationType
  callId?: string
  conversationId?: string
  channelType?: string
  shiftId?: string
  startsAt?: string
}

export interface FullPushPayload extends WakePayload {
  senderLast4?: string
  previewText?: string
  duration?: number
  callerLast4?: string
  shiftName?: string
  role?: string
}
```

All push dispatch call sites in `push-dispatch.ts` and `voip-push.ts` already operate within a hub context — populate `hubId` from that context. Update the protocol schema and run codegen.

### 2. `hubId` in VoIP Push Payload

`apps/worker/lib/voip-push.ts` — the VoIP push payload sent to Linphone must include `hubId`:

```typescript
// Payload sent to APNs (PushKit) and FCM (high-priority)
{
  callId: string,
  caller: string,   // obfuscated caller display
  hubId: string,    // NEW — stored by client and correlated to inbound SIP call by callId
}
```

`hubId` comes from the push payload — not from SIP headers — because VoIP push may wake the app before any SIP connection is established. See "Hub Attribution for Inbound Calls" below.

### 3. No New Endpoints

Device token registration is already per-user (not per-hub) — correct. One device registration covers all hubs. No new server endpoints required.

> **Correction (2026-09-27, #1188):** this spec originally stated that `GET /hubs/{hubId}/telephony/sip-token` exists and is hub-scoped. **It does not.** The real route is `GET /api/telephony/sip-token` (`apps/worker/app.ts`, mounted on the authenticated router), and it is **not hub-scoped**: it returns the same credentials whichever hub is active. The iOS client called the non-existent hub-scoped path and swallowed the 404. Clients fetch credentials once and register them for every member hub; hubs sharing credentials share one SIP registration.

---

## Eager Hub Key Loading

### At Login (iOS + Android)

After authenticating and receiving the hub list, load hub keys for all hubs before completing the login flow.

**iOS** — in `AppState` post-login:

```swift
func loadAllHubKeys(hubs: [Hub]) async {
    await withTaskGroup(of: Void.self) { group in
        for hub in hubs {
            group.addTask { [weak self] in
                guard let self else { return }
                do {
                    let envelope = try await self.apiService.getHubKey(hub.id)
                    try self.cryptoService.loadHubKey(hubId: hub.id, envelope: envelope)
                } catch {
                    // Log and skip — user may have been removed from hub between sessions
                    print("Warning: failed to load hub key for \(hub.id): \(error)")
                }
            }
        }
    }
}
```

**Android** — in `HubRepository`:

```kotlin
suspend fun loadAllHubKeys(hubs: List<Hub>) {
    hubs.map { hub ->
        async {
            runCatching {
                val envelope = apiService.getHubKey(hub.id)
                cryptoService.loadHubKey(hub.id, envelope)
            }.onFailure { e ->
                Log.w("HubRepository", "Failed to load key for hub ${hub.id}: ${e.message}")
            }
        }
    }.awaitAll()
}
```

Keys are fetched in parallel. Individual failures are logged and skipped — a missing key means relay events from that hub will fail to decrypt and be silently ignored, which is safe.

### Consequence for Spec 1 `switchHub()`

With all hub keys pre-loaded, `switchHub()` no longer fetches the key — it only updates `activeHubId`. However, the key may not be cached if loading failed at login (network error, hub membership changed). `switchHub()` must handle this: attempt an on-demand fetch if the key is not in the cache, and surface an error if that also fails. This supersedes spec 1's "abort switch if key fetch fails" — the abort condition now only triggers on cache-miss + on-demand fetch failure, not on every switch.

### Hub Membership Changes

When the relay emits a hub membership event for the current user:
- **Added to hub**: fetch and cache the new hub's key immediately, register a Linphone SIP account if on shift
- **Removed from hub**: evict the departed hub's key from the cache, unregister its Linphone SIP account

### Cache Eviction

Hub key cache cleared on lock and logout, as defined in spec 1. After `lock()` or `logout()`, `cryptoService.hubKeyCount == 0` (unit-testable).

---

## Multi-Hub Relay Event Routing

### Event Type Contract

The protocol codegen produces a `ProtocolHubEvent` type (generated from the Zod schema in `packages/protocol/schemas/`) for Swift and Kotlin. This is the structured event type used throughout — not the raw `HubEventType` enum currently in `WebSocketService`. The `WebSocketService` refactor introduced by this spec replaces the existing `AsyncStream<HubEventType>` with `AsyncStream<AttributedHubEvent>`:

```swift
// iOS — new attributed event type
struct AttributedHubEvent {
    let hubId: String
    let event: ProtocolHubEvent  // generated type from protocol codegen
}
```

```kotlin
// Android
data class AttributedHubEvent(
    val hubId: String,
    val event: ProtocolHubEvent,
)
```

### Hub Attribution via Decryption

**iOS:**

```swift
func decryptEvent(_ encryptedContent: String) -> AttributedHubEvent? {
    for (hubId, key) in cryptoService.allHubKeys() {
        guard let plaintext = try? cryptoService.decrypt(encryptedContent, using: key),
              let event = try? JSONDecoder().decode(ProtocolHubEvent.self, from: plaintext)
        else { continue }
        return AttributedHubEvent(hubId: hubId, event: event)
    }
    return nil  // Not for this user's hubs — ignore
}
```

**Android:**

```kotlin
fun decryptEvent(encryptedContent: String): AttributedHubEvent? {
    for ((hubId, key) in cryptoService.allHubKeys()) {
        val plaintext = runCatching { cryptoService.decrypt(encryptedContent, key) }
            .getOrNull() ?: continue
        val event = runCatching { json.decodeFromString<ProtocolHubEvent>(plaintext) }
            .getOrNull() ?: continue
        return AttributedHubEvent(hubId, event)
    }
    return null
}
```

Events that fail all hub key decryptions are silently ignored — consistent with the server-blind security model.

### Event Consumers

All relay event consumers are updated to receive `AttributedHubEvent`. Consumers scoped to the active hub filter by `hubId == activeHubId`. Background consumers (call handler, activity indicators) process events from all hubs.

---

## Push Notification Routing

When a push notification arrives with `hubId`:

**On tap (iOS `UNUserNotificationCenterDelegate.didReceiveResponse` / Android notification intent):**
1. Read `hubId` from payload
2. Call `hubContext.setActiveHub(hubId)` / `activeHubState.setActiveHub(hubId)`
3. Navigate to the relevant screen (`/calls`, `/conversations`, etc.)

---

## Hub Attribution for Inbound Calls

VoIP push may wake the app from a killed or suspended state before any SIP connection exists. The `hubId` must come from the push payload — not from SIP `X-Hub-Id` headers, which are only available once the SIP INVITE arrives over the wire.

**Mechanism:** When a VoIP push is received, store `(callId → hubId)` in a pending call map before Linphone processes the INVITE. In the Linphone `onCallStateChanged` callback, look up `hubId` by `callId`:

**iOS:**

```swift
// In LinphoneService — populated from VoIP push handler
private var pendingCallHubIds: [String: String] = [:]  // callId → hubId

func handleVoipPush(payload: [String: Any]) {
    guard let callId = payload["callId"] as? String,
          let hubId = payload["hubId"] as? String else { return }
    pendingCallHubIds[callId] = hubId
    // Let Linphone process the push
}

// CoreDelegate
func onCallStateChanged(core: Core, call: Call, state: Call.State, message: String) {
    // CORRECTION (#1188): switching hubs on IncomingReceived (the RING) violates the
    // multi-hub routing axiom. Ringing must be hub-agnostic; the switch belongs on the
    // app-unlocked ANSWER path (Connected on an incoming call). See LinphoneService.swift.
    if state == .IncomingReceived {
        if let callId = call.callLog?.callId,
           let hubId = pendingCallHubIds[callId] {
            hubContext.setActiveHub(hubId)
            pendingCallHubIds.removeValue(forKey: callId)
        }
    }
    if state == .Released || state == .End {
        if let callId = call.callLog?.callId {
            pendingCallHubIds.removeValue(forKey: callId)
        }
    }
}
```

**Android:** Same pattern in `LinphoneService` — a `ConcurrentHashMap<String, String>` populated in the FCM push handler, read in `CoreListenerStub.onCallStateChanged`.

---

## PushKit Ownership (iOS)

Linphone SDK registers its own `PKPushRegistry` delegate internally when `core.start()` is called. There must be exactly one `PKPushRegistry` delegate in the app. Any existing VoIP PushKit registration in `LlamenosApp` or `AppDelegate` must be removed when Linphone is integrated — Linphone becomes the sole owner of the VoIP push channel. Regular APNs (non-VoIP push) continues to be handled by the existing `AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken`.

---

## Per-Hub Activity Indicators

The hub list screen shows live per-hub status badges driven by relay events.

```swift
// iOS
struct HubActivityState {
    var isOnShift: Bool = false
    var activeCallCount: Int = 0
    var unreadMessageCount: Int = 0
    var unreadConversationCount: Int = 0
}
```

```kotlin
// Android
data class HubActivityState(
    val isOnShift: Boolean = false,
    val activeCallCount: Int = 0,
    val unreadMessageCount: Int = 0,
    val unreadConversationCount: Int = 0,
)
```

**State machine for each hub:**

| Event | Effect |
|---|---|
| `shiftStarted` | `isOnShift = true` |
| `shiftEnded` | `isOnShift = false` |
| `callRing` | `activeCallCount += 1` |
| `callAnswered` / `callEnded` / `callVoicemail` | `activeCallCount = max(0, activeCallCount - 1)` |
| `messageNew` | `unreadMessageCount += 1` |
| `conversationAssigned` | `unreadConversationCount += 1` |
| User opens hub (switches `activeHubId` to this hub) | `unreadMessageCount = 0`, `unreadConversationCount = 0` |
| `conversationClosed` | `unreadConversationCount = max(0, unreadConversationCount - 1)` |

This state machine is defined once and shared between iOS and Android implementations. Both platforms must implement the same transitions to prevent divergent indicator behavior.

---

## Linphone Native Integration

### Why Epic 91 Is Superseded

Epic 91 designed a React Native Turbo Native Module (`llamenos-sip`). The Llamenos mobile apps are native SwiftUI (iOS) and Kotlin/Compose (Android) — not React Native. No Turbo Module, no `NativeModules`, no `useVoip()` hook. The Linphone SDK design (provider-agnostic SIP, SRTP, CallKit, ConnectionService, multi-account) is correct and is carried forward; only the integration layer changes.

### iOS — `LinphoneService.swift`

An `@Observable` singleton owning the Linphone `Core`. Integrated via **CocoaPods** (`pod 'linphone-sdk'`) — the official Linphone iOS distribution is CocoaPods or direct XCFramework; no official SPM package exists. This requires adding a `Podfile` to `apps/ios/` alongside the existing SPM packages and configuring `xcodegen`'s `project.yml` to support CocoaPods (`generateSchemes: false` under `options` is incompatible with pod install — review xcodegen + CocoaPods interop). The Linphone XCFramework alternative (manual integration, no CocoaPods) is the preferred path if it avoids adding a `Podfile` to a currently pure-SPM project. Pin to a specific SDK version (e.g. `5.3.x`) — Linphone API surfaces change between major versions.

**Initialization — called from `LlamenosApp` init or `AppState.init()`:**

```swift
func initialize() throws {
    let factory = Factory.Instance
    // Pin to explicit config filenames (not paths — SDK 5.x API)
    let core = try factory.createCore(
        configFilename: "linphone",
        factoryConfigFilename: nil,
        systemContext: nil
    )
    core.callKitEnabled = true          // capital K — SDK 5.x property name
    core.mediaEncryption = .SRTP
    core.mediaEncryptionMandatory = true
    // enable() is a method call, not a property setter
    core.audioPayloadTypes.forEach {
        $0.enable($0.mimeType == "opus" || $0.mimeType == "PCMU")
    }
    try core.start()
    self.core = core
}
```

Linphone's internal `PKPushRegistry` delegate registers for VoIP push when `core.start()` is called. The existing app's VoIP PushKit registration (if any) must be removed — Linphone is the sole PushKit owner.

**SIP registration per hub on shift:**

```swift
func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
    guard let core else { throw LinphoneError.notInitialized }
    let params = try core.createAccountParams()
    let identity = try Factory.Instance.createAddress(addr: "sip:\(sipParams.username)@\(sipParams.domain)")
    try params.setIdentityaddress(newValue: identity)
    let server = try Factory.Instance.createAddress(addr: "sip:\(sipParams.domain);transport=\(sipParams.transport)")
    try params.setServeraddress(newValue: server)
    params.registerEnabled = true
    // Linphone reads voipToken from its own PKPushRegistry — no manual token injection needed
    let account = try core.createAccount(params: params)
    try core.addAccount(account: account)
    hubAccounts[hubId] = account
}

func unregisterHubAccount(hubId: String) {
    guard let account = hubAccounts.removeValue(forKey: hubId) else { return }
    core?.removeAccount(account: account)
}
```

**Shift integration:** `ShiftViewModel` calls `linphoneService.registerHubAccount()` on shift start and `unregisterHubAccount()` on shift end.

### Android — `LinphoneService.kt`

A Hilt `@Singleton` wrapping `org.linphone:linphone-sdk-android`. Dependency:

```gradle
// apps/android/app/build.gradle
repositories {
    maven { url "https://linphone.org/maven_repository/" }
}
dependencies {
    implementation 'org.linphone:linphone-sdk-android:5.3.+'
}
```

**`initialize()` must be called from `Application.onCreate()`** — Linphone requires the Android `Context` to initialize audio subsystems before any Activity starts. Create `LlamenosApplication.kt` (or extend the existing application class) and inject `LinphoneService` there:

```kotlin
@HiltAndroidApp
class LlamenosApplication : Application() {
    @Inject lateinit var linphoneService: LinphoneService

    override fun onCreate() {
        super.onCreate()
        linphoneService.initialize()
    }
}
```

Register in `AndroidManifest.xml`:
```xml
<application android:name=".LlamenosApplication" ...>
```

**ConnectionService declaration** — Linphone's `ConnectionService` subclass must be declared in `AndroidManifest.xml`:

```xml
<service
    android:name="org.linphone.core.tools.service.CoreService"
    android:foregroundServiceType="phoneCall"
    android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"
    android:exported="true">
    <intent-filter>
        <action android:name="android.telecom.ConnectionService"/>
    </intent-filter>
</service>
```

This enables Linphone's native `ConnectionService` which shows full-screen incoming call UI.

**`LinphoneService.kt`:**

```kotlin
@Singleton
class LinphoneService @Inject constructor(
    @ApplicationContext private val context: Context,
    private val activeHubState: ActiveHubState,
    @ApplicationScope private val scope: CoroutineScope,
) {
    private var core: Core? = null
    private val hubAccounts = mutableMapOf<String, Account>()
    private val pendingCallHubIds = ConcurrentHashMap<String, String>() // callId → hubId

    fun initialize() {
        val factory = Factory.instance()
        val core = factory.createCore(null, null, context)
        core.isCallkitIntegrationEnabled = true  // enables Android ConnectionService
        core.mediaEncryption = MediaEncryption.SRTP
        core.isMediaEncryptionMandatory = true
        core.audioPayloadTypes.forEach { it.enable(it.mimeType == "opus" || it.mimeType == "PCMU") }
        core.start()
        this.core = core
        setupCoreListener()
    }

    // Called from FCM push handler before Linphone processes the INVITE
    fun storePendingCallHub(callId: String, hubId: String) {
        pendingCallHubIds[callId] = hubId
    }

    fun registerHubAccount(hubId: String, sipParams: SipTokenResponse) {
        val core = this.core ?: return
        val params = core.createAccountParams()
        val identity = Factory.instance().createAddress("sip:${sipParams.username}@${sipParams.domain}")
        params.identityAddress = identity
        val server = Factory.instance().createAddress("sip:${sipParams.domain};transport=${sipParams.transport}")
        params.serverAddress = server
        params.isRegisterEnabled = true
        val account = core.createAccount(params)
        core.addAccount(account)
        hubAccounts[hubId] = account
    }

    fun unregisterHubAccount(hubId: String) {
        val account = hubAccounts.remove(hubId) ?: return
        core?.removeAccount(account)
    }

    private fun setupCoreListener() {
        core?.addListener(object : CoreListenerStub() {
            override fun onCallStateChanged(
                core: Core, call: Call, state: Call.State, message: String
            ) {
                val callId = call.callLog?.callId ?: return
                when (state) {
                    // CORRECTION (#1188): do not switch hubs on the ring — see iOS note above.
                    Call.State.IncomingReceived -> {
                        pendingCallHubIds.remove(callId)?.let { hubId ->
                            scope.launch { activeHubState.setActiveHub(hubId) }
                        }
                    }
                    Call.State.Released, Call.State.End -> {
                        pendingCallHubIds.remove(callId)
                    }
                    else -> {}
                }
            }
        })
    }
}
```

### Provider SIP Config Mapping

`GET /api/telephony/sip-token` (not hub-scoped — see the correction above) returns provider-specific SIP params. The mobile client maps these to Linphone account configuration:

| Provider | domain | transport | encryption |
|---|---|---|---|
| Twilio | `{account}.pstn.twilio.com` | tls | SRTP |
| SignalWire | `{space}.signalwire.com` | tls | SRTP |
| Plivo | `phone.plivo.com` | tls | SRTP |
| Asterisk | `{host}` | tls/wss | ZRTP |
| Vonage | via Asterisk gateway | tls | ZRTP |

### Required Permissions

**iOS** (`apps/ios/project.yml` / `Info.plist`):
- `NSMicrophoneUsageDescription` — answering crisis calls
- `UIBackgroundModes`: `voip`, `audio`
- PushKit entitlement (`aps-environment` with `voip` capability)

**Android** (`apps/android/app/src/main/AndroidManifest.xml`):
- `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` (new)
- `BLUETOOTH`, `BLUETOOTH_CONNECT` (new)
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL` (already declared)
- `USE_FULL_SCREEN_INTENT`, `MANAGE_OWN_CALLS` (new)

### AGPLv3 License

Linphone SDK is AGPLv3. Llamenos is AGPLv3-compatible. Source for the native integration lives in this repo and must remain available.

---

## Security Notes

- SIP credentials are fetched fresh via `GET /api/telephony/sip-token` (not hub-specific — corrected 2026-09-27, #1188) and never persisted to disk
- VoIP push payloads carry only `callId`, `caller` (obfuscated), and `hubId` — no PII
- Media encryption: SRTP mandatory for all providers, ZRTP where supported
- Linphone handles PushKit before the SwiftUI layer starts — satisfies Apple's iOS 13+ VoIP push mandate (report to CallKit immediately in push handler)

---

## Implementation Order

1. **Backend: add `hubId` to push payloads** — small, unblocks all client routing
2. **Eager hub key loading** — prerequisite for relay event routing
3. **Hub-attributed relay events** — `AttributedHubEvent` stream, update all consumers; refactor `WebSocketService` from `HubEventType` to `ProtocolHubEvent`
4. **Per-hub activity indicators** — depends on attributed events
5. **Push notification routing** — depends on `hubId` in payload (step 1)
6. **Linphone integration** — iOS then Android; resolve CocoaPods/XCFramework build system question first; `LlamenosApplication` wiring; SIP account per shift; pending call hub map

---

## Success Criteria

### CI-Verifiable
- `WakePayload.hubId` and `FullPushPayload.hubId` populated on all push dispatch paths; codegen updated; TypeScript and generated Swift/Kotlin types compile
- `loadAllHubKeys()` called at login; unit tests verify all hub keys are in cache after login with multiple hubs
- `WebSocketService` emits `AttributedHubEvent` — unit tests verify correct hub attribution by decryption (using test hub keys)
- Hub activity state machine unit tests: correct increments/decrements for all relay event types on both platforms
- After `lock()` or `logout()`, `cryptoService.hubKeyCount == 0`
- `switchHub()` on-demand key fetch verified by unit test (simulate cache miss, verify fetch occurs)
- Android: `LlamenosApplication` injects and calls `linphoneService.initialize()` — unit test verifies `core` is non-null after app start

### Device/Integration (manual or device farm)
- Tapping a push notification for Hub B while Hub A is active switches the UI to Hub B and navigates to the correct screen
- iOS: Linphone `Core` initializes with SRTP + Opus; SIP REGISTER succeeds against a test Twilio/Asterisk endpoint
- iOS: Incoming call appears on lock screen via CallKit; accepting the call switches `activeHubId` to the call's hub (verified via `X-Hub-Id` fallback or pending call map)
- Android: FCM high-priority data message wakes app; ConnectionService full-screen notification shown; call answer switches active hub
- Shift start → SIP account registered; shift end → account unregistered (verified in device session logs)
- Per-hub activity badges update live for non-active hubs
- No regressions for single-hub users
