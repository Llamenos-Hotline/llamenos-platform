package org.llamenos.hotline.screenshots

import com.github.takahirom.roborazzi.captureRoboImage
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.model.ActiveCall
import org.llamenos.protocol.SharedEntry
import org.llamenos.hotline.model.BanEntry
import org.llamenos.hotline.model.ContactSummary
import org.llamenos.hotline.model.Conversation
import org.llamenos.hotline.model.DecryptedMessage
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.model.Report
import org.llamenos.hotline.model.User
import org.llamenos.hotline.ui.admin.AdminUiState
import org.llamenos.hotline.ui.admin.AdminViewModel
import org.llamenos.hotline.ui.admin.AdminScreen
import org.llamenos.hotline.ui.auth.AuthUiState
import org.llamenos.hotline.ui.auth.AuthViewModel
import org.llamenos.hotline.ui.auth.LoginScreen
import org.llamenos.hotline.ui.auth.PINUnlockScreen
import org.llamenos.hotline.ui.calls.CallHistoryScreen
import org.llamenos.hotline.ui.calls.CallHistoryUiState
import org.llamenos.hotline.ui.calls.CallHistoryViewModel
import org.llamenos.hotline.ui.calls.DecryptedCallRecord
import org.llamenos.hotline.ui.cases.CaseListScreen
import org.llamenos.hotline.ui.cases.CaseManagementViewModel
import org.llamenos.hotline.ui.cases.CaseUiState
import org.llamenos.hotline.ui.contacts.ContactsScreen
import org.llamenos.hotline.ui.contacts.ContactsUiState
import org.llamenos.hotline.ui.contacts.ContactsViewModel
import org.llamenos.hotline.ui.conversations.ConversationDetailScreen
import org.llamenos.hotline.ui.conversations.ConversationsScreen
import org.llamenos.hotline.ui.conversations.ConversationsUiState
import org.llamenos.hotline.ui.conversations.ConversationsViewModel
import org.llamenos.hotline.ui.dashboard.DashboardScreen
import org.llamenos.hotline.ui.dashboard.DashboardUiState
import org.llamenos.hotline.ui.dashboard.DashboardViewModel
import org.llamenos.hotline.ui.events.EventListScreen
import org.llamenos.hotline.ui.events.EventsUiState
import org.llamenos.hotline.ui.events.EventsViewModel
import org.llamenos.hotline.ui.messaging.BlastsScreen
import org.llamenos.hotline.ui.messaging.BlastItem
import org.llamenos.hotline.ui.messaging.BlastsUiState
import org.llamenos.hotline.ui.messaging.BlastsViewModel
import org.llamenos.hotline.ui.notes.DecryptedNote
import org.llamenos.hotline.ui.notes.NoteDetailScreen
import org.llamenos.hotline.ui.notes.NotesScreen
import org.llamenos.hotline.ui.notes.NotesUiState
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.reports.ReportsScreen
import org.llamenos.hotline.ui.reports.ReportsUiState
import org.llamenos.hotline.ui.reports.ReportsViewModel
import org.llamenos.hotline.ui.settings.BiometricSectionState
import org.llamenos.hotline.ui.settings.SettingsScreen
import org.llamenos.hotline.ui.shifts.ShiftsScreen
import org.llamenos.hotline.ui.shifts.ShiftsUiState
import org.llamenos.hotline.ui.shifts.ShiftsViewModel
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.llamenos.hotline.ui.triage.TriageScreen
import org.llamenos.hotline.ui.triage.TriageUiState
import org.llamenos.hotline.ui.triage.TriageViewModel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.llamenos.hotline.model.ActiveCallResponseStatus
import org.llamenos.hotline.model.CallHistoryResponseCall
import org.llamenos.protocol.Record
import org.llamenos.protocol.Shift
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// Screenshots are saved to site/public/screenshots/android/ (relative to the
// module root at apps/android/app/, so ../../../ resolves to the monorepo root).
private const val OUT = "../../../site/public/screenshots/android"

/**
 * Roborazzi screenshot tests for all major Llamenos Android screens.
 *
 * Run with: cd apps/android && ./gradlew recordRoborazziDebug
 *
 * Each test mocks the relevant ViewModel(s) with realistic pre-populated state
 * and renders the screen in dark theme to match the app's default.
 */
@RunWith(org.robolectric.RobolectricTestRunner::class)
// w411dp-h891dp-xxhdpi → 1233×2673px — close to Pixel 8 Pro proportions
@Config(sdk = [34], application = ScreenshotTestApp::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenshotTests {

    // ─────────────────────────────────────────────────────────────────────────
    // Shared sample data
    // ─────────────────────────────────────────────────────────────────────────

    private val samplePubkey = "npub1abc123def456abc123def456abc123def456abc123def456abc123def456ab"
    private val samplePubkey2 = "npub1xyz789ghi000xyz789ghi000xyz789ghi000xyz789ghi000xyz789ghi000xy"
    private val sampleTimestamp = "2026-04-29T14:30:00Z"
    private val sampleTimestamp2 = "2026-04-29T09:15:00Z"

    private val sampleNotes = listOf(
        DecryptedNote(
            id = "note-001",
            text = "Caller was distressed about housing situation. Provided resource list and warm handoff to shelter services. Caller expressed gratitude.",
            fields = null,
            authorPubkey = samplePubkey,
            callId = "call-001",
            conversationId = null,
            replyCount = 2,
            createdAt = sampleTimestamp,
            updatedAt = null,
        ),
        DecryptedNote(
            id = "note-002",
            text = "Follow-up call — caller doing better. Connected with community resources.",
            fields = null,
            authorPubkey = samplePubkey,
            callId = "call-002",
            conversationId = null,
            replyCount = 0,
            createdAt = sampleTimestamp2,
            updatedAt = null,
        ),
        DecryptedNote(
            id = "note-003",
            text = "Crisis call — immediate safety planning completed. Emergency services notified.",
            fields = null,
            authorPubkey = samplePubkey2,
            callId = "call-003",
            conversationId = null,
            replyCount = 1,
            createdAt = "2026-04-28T22:10:00Z",
            updatedAt = null,
        ),
    )

    private val sampleCallRecords = listOf(
        CallHistoryResponseCall(
            id = "call-001",
            startedAt = sampleTimestamp,
            status = ActiveCallResponseStatus.Completed,
            answeredBy = samplePubkey,
            duration = 185.0,
            callerLast4 = "7890",
        ),
        CallHistoryResponseCall(
            id = "call-002",
            startedAt = sampleTimestamp2,
            status = ActiveCallResponseStatus.Completed,
            answeredBy = samplePubkey2,
            duration = 423.0,
            callerLast4 = "3456",
        ),
        CallHistoryResponseCall(
            id = "call-003",
            startedAt = "2026-04-28T22:10:00Z",
            status = ActiveCallResponseStatus.Unanswered,
            answeredBy = null,
            duration = null,
            callerLast4 = "1122",
        ),
        CallHistoryResponseCall(
            id = "call-004",
            startedAt = "2026-04-28T18:45:00Z",
            status = ActiveCallResponseStatus.Completed,
            answeredBy = samplePubkey,
            duration = 612.0,
            callerLast4 = "9988",
        ),
    )

    private val sampleConversations = listOf(
        Conversation(
            id = "conv-001",
            channelType = "sms",
            contactHash = "hash-abc",
            assignedVolunteerPubkey = samplePubkey,
            status = "active",
            lastMessageAt = sampleTimestamp,
            unreadCount = 3,
            createdAt = sampleTimestamp2,
        ),
        Conversation(
            id = "conv-002",
            channelType = "signal",
            contactHash = "hash-def",
            assignedVolunteerPubkey = null,
            status = "waiting",
            lastMessageAt = "2026-04-29T11:00:00Z",
            unreadCount = 1,
            createdAt = "2026-04-27T08:00:00Z",
        ),
        Conversation(
            id = "conv-003",
            channelType = "whatsapp",
            contactHash = "hash-ghi",
            assignedVolunteerPubkey = samplePubkey2,
            status = "active",
            lastMessageAt = "2026-04-29T07:30:00Z",
            unreadCount = 0,
            createdAt = "2026-04-20T14:00:00Z",
        ),
    )

    private val sampleMessages = listOf(
        DecryptedMessage(
            id = "msg-001",
            text = "Hello, I need some help with my situation.",
            direction = "inbound",
            channelType = "sms",
            createdAt = sampleTimestamp2,
            isRead = true,
        ),
        DecryptedMessage(
            id = "msg-002",
            text = "Thank you for reaching out. I'm here to listen. Can you tell me more about what's going on?",
            direction = "outbound",
            channelType = "sms",
            createdAt = "2026-04-29T09:20:00Z",
            isRead = true,
        ),
        DecryptedMessage(
            id = "msg-003",
            text = "I've been feeling really overwhelmed lately with work and family stuff.",
            direction = "inbound",
            channelType = "sms",
            createdAt = "2026-04-29T09:25:00Z",
            isRead = true,
        ),
        DecryptedMessage(
            id = "msg-004",
            text = "That sounds really difficult. It's completely understandable to feel that way. Let's work through this together.",
            direction = "outbound",
            channelType = "sms",
            createdAt = sampleTimestamp,
            isRead = false,
        ),
    )

    private val sampleContacts = listOf(
        ContactSummary(
            contactHash = "hash-abc",
            last4 = "7890",
            firstSeen = "2025-08-15T09:00:00Z",
            lastSeen = sampleTimestamp,
            callCount = 8,
            conversationCount = 3,
            noteCount = 12,
            reportCount = 2,
        ),
        ContactSummary(
            contactHash = "hash-def",
            last4 = "3456",
            firstSeen = "2025-11-01T12:00:00Z",
            lastSeen = sampleTimestamp2,
            callCount = 2,
            conversationCount = 1,
            noteCount = 3,
            reportCount = 0,
        ),
        ContactSummary(
            contactHash = "hash-ghi",
            last4 = null,
            firstSeen = "2026-03-20T16:00:00Z",
            lastSeen = "2026-04-28T20:00:00Z",
            callCount = 1,
            conversationCount = 2,
            noteCount = 1,
            reportCount = 1,
        ),
        ContactSummary(
            contactHash = "hash-jkl",
            last4 = "1122",
            firstSeen = "2026-01-10T08:00:00Z",
            lastSeen = "2026-04-20T15:00:00Z",
            callCount = 15,
            conversationCount = 6,
            noteCount = 22,
            reportCount = 4,
        ),
    )

    private val sampleShifts = listOf(
        Shift(
            createdAt = "2026-04-01T00:00:00Z",
            days = listOf(1.0, 3.0, 5.0),
            encryptedName = "Evening Support Shift",
            endTime = "22:00",
            id = "shift-001",
            startTime = "18:00",
            userPubkeys = listOf(samplePubkey, samplePubkey2),
        ),
        Shift(
            createdAt = "2026-04-01T00:00:00Z",
            days = listOf(6.0, 0.0),
            encryptedName = "Overnight Weekend Shift",
            endTime = "08:00",
            id = "shift-002",
            startTime = "22:00",
            userPubkeys = listOf(samplePubkey2),
        ),
        Shift(
            createdAt = "2026-04-01T00:00:00Z",
            days = listOf(1.0, 2.0, 3.0, 4.0, 5.0),
            encryptedName = "Weekday Morning Shift",
            endTime = "14:00",
            id = "shift-003",
            startTime = "08:00",
            userPubkeys = listOf(samplePubkey),
        ),
    )

    private val sampleRecord = Record(
        assignedTo = listOf(samplePubkey),
        blindIndexes = emptyMap(),
        contactCount = 1.0,
        createdAt = "2026-04-20T09:00:00Z",
        createdBy = samplePubkey,
        encryptedSummary = "dGVzdA==",
        entityTypeID = "entity-type-001",
        eventIDS = emptyList(),
        fileCount = 0.0,
        hubID = "hub-001",
        id = "record-001",
        interactionCount = 3.0,
        reportCount = 0.0,
        reportIDS = emptyList(),
        statusHash = "open",
        summaryEnvelopes = emptyList(),
        updatedAt = sampleTimestamp,
    )

    private val sampleReports = listOf(
        Report(
            id = "report-001",
            channelType = "reports",
            contactHash = "hash-abc",
            assignedTo = samplePubkey,
            status = "open",
            createdAt = sampleTimestamp2,
            messageCount = 3,
            metadata = null,
        ),
        Report(
            id = "report-002",
            channelType = "reports",
            contactHash = "hash-def",
            assignedTo = null,
            status = "pending",
            createdAt = "2026-04-28T15:00:00Z",
            messageCount = 0,
            metadata = null,
        ),
        Report(
            id = "report-003",
            channelType = "reports",
            contactHash = "hash-ghi",
            assignedTo = samplePubkey2,
            status = "resolved",
            createdAt = "2026-04-27T10:00:00Z",
            messageCount = 7,
            metadata = null,
        ),
    )

    private val sampleEntityType = EntityTypeDefinition(
        id = "entity-type-001",
        hubID = "hub-001",
        name = "support_case",
        label = "Support Case",
        labelPlural = "Support Cases",
        description = "Individual support case records",
        category = org.llamenos.protocol.SharedEntityTypeDefinitionCategory.Case,
        defaultAccessLevel = org.llamenos.protocol.SharedDefaultAccessLevel.Assigned,
    )

    private val sampleUsers = listOf(
        User(
            active = true,
            name = "Sarah Chen",
            pubkey = samplePubkey,
            roles = listOf("role-volunteer"),
            createdAt = "2026-01-15T00:00:00Z",
        ),
        User(
            active = true,
            name = "Marcus Rivera",
            pubkey = samplePubkey2,
            roles = listOf("role-volunteer"),
            createdAt = "2026-02-01T00:00:00Z",
        ),
        User(
            active = true,
            name = "Jordan Lee",
            pubkey = "npub1admin000000000000000000000000000000000000000000000000000000ad",
            roles = listOf("role-admin"),
            createdAt = "2025-12-01T00:00:00Z",
        ),
    )

    private val sampleBans = listOf(
        BanEntry(
            bannedAt = "2026-04-15T10:00:00Z",
            bannedBy = samplePubkey,
            phone = "ban-hash-abc",
            phoneHash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            reason = "Repeated abusive calls targeting volunteers",
        ),
        BanEntry(
            bannedAt = "2026-04-10T14:30:00Z",
            bannedBy = samplePubkey2,
            phone = "ban-hash-def",
            phoneHash = "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
            reason = "Spam calls",
        ),
    )

    private val sampleAuditEntries = listOf(
        SharedEntry(
            id = "audit-001",
            action = "call.answered",
            actorPubkey = samplePubkey,
            details = JsonObject(mapOf("description" to JsonPrimitive("Call ID: call-001, Duration: 3m 5s"))),
            entryHash = "sha256-001",
            previousEntryHash = null,
            createdAt = sampleTimestamp,
        ),
        SharedEntry(
            id = "audit-002",
            action = "note.created",
            actorPubkey = samplePubkey,
            details = JsonObject(mapOf("description" to JsonPrimitive("Note ID: note-001"))),
            entryHash = "sha256-002",
            previousEntryHash = "sha256-001",
            createdAt = sampleTimestamp2,
        ),
        SharedEntry(
            id = "audit-003",
            action = "user.created",
            actorPubkey = "npub1admin000000000000000000000000000000000000000000000000000000ad",
            details = JsonObject(mapOf("description" to JsonPrimitive("New volunteer: Sarah Chen"))),
            entryHash = "sha256-003",
            previousEntryHash = "sha256-002",
            createdAt = "2026-04-01T09:00:00Z",
        ),
    )

    // ─────────────────────────────────────────────────────────────────────────
    // Auth screens
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun loginScreen() {
        val vm = mockk<AuthViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            AuthUiState(hubUrl = "https://llamenos.example.org")
        )
        captureRoboImage("$OUT/login-android.png") {
            LlamenosTheme(darkTheme = true) {
                LoginScreen(viewModel = vm, onNavigateToPinSet = {})
            }
        }
    }

    @Test
    fun pinUnlockScreen() {
        val vm = mockk<AuthViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(AuthUiState())
        captureRoboImage("$OUT/pin-unlock-android.png") {
            LlamenosTheme(darkTheme = true) {
                PINUnlockScreen(
                    viewModel = vm,
                    onAuthenticated = {},
                    onResetIdentity = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dashboard
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun dashboardScreen() {
        val vm = mockk<DashboardViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            DashboardUiState(
                signingPubkey = samplePubkey,
                isOnShift = true,
                shiftStartedAt = sampleTimestamp2,
                activeCallCount = 2,
                callsToday = 14,
                connectionState = WebSocketService.ConnectionState.CONNECTED,
                currentCall = ActiveCall(
                    id = "call-active-001",
                    callerNumber = "+1 (555) 123-****",
                    answeredBy = samplePubkey,
                    startedAt = sampleTimestamp,
                    status = "in-progress",
                ),
            )
        )
        val notesVm = mockk<NotesViewModel>(relaxed = true)
        every { notesVm.uiState } returns MutableStateFlow(
            NotesUiState(notes = sampleNotes)
        )
        captureRoboImage("$OUT/dashboard-android.png") {
            LlamenosTheme(darkTheme = true) {
                DashboardScreen(
                    viewModel = vm,
                    notesViewModel = notesVm,
                    onLock = {},
                    onLogout = {},
                    onNavigateToNotes = {},
                    onNavigateToNoteDetail = {},
                    onNavigateToCallHistory = {},
                    onNavigateToReports = {},
                    onNavigateToContacts = {},
                    onNavigateToCases = {},
                    onNavigateToBlasts = {},
                    onNavigateToHelp = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Calls
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun callHistoryScreen() {
        val vm = mockk<CallHistoryViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            CallHistoryUiState(
                calls = sampleCallRecords.map { DecryptedCallRecord(it) },
                total = sampleCallRecords.size,
            )
        )
        captureRoboImage("$OUT/call-history-android.png") {
            LlamenosTheme(darkTheme = true) {
                CallHistoryScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Notes
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun notesScreen() {
        val vm = mockk<NotesViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            NotesUiState(
                notes = sampleNotes,
                totalNotes = sampleNotes.size,
            )
        )
        every { vm.filteredNotes() } returns sampleNotes
        captureRoboImage("$OUT/notes-android.png") {
            LlamenosTheme(darkTheme = true) {
                NotesScreen(
                    viewModel = vm,
                    onNavigateToCreate = {},
                    onNavigateToDetail = {},
                )
            }
        }
    }

    @Test
    fun noteDetailScreen() {
        val vm = mockk<NotesViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            NotesUiState(
                notes = sampleNotes,
                selectedNote = sampleNotes[0],
            )
        )
        captureRoboImage("$OUT/note-detail-android.png") {
            LlamenosTheme(darkTheme = true) {
                NoteDetailScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Conversations
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun conversationsScreen() {
        val vm = mockk<ConversationsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            ConversationsUiState(
                conversations = sampleConversations,
                totalConversations = sampleConversations.size,
                totalUnread = 4,
            )
        )
        captureRoboImage("$OUT/conversations-android.png") {
            LlamenosTheme(darkTheme = true) {
                ConversationsScreen(
                    viewModel = vm,
                    onNavigateToDetail = {},
                )
            }
        }
    }

    @Test
    fun conversationDetailScreen() {
        val vm = mockk<ConversationsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            ConversationsUiState(
                conversations = sampleConversations,
                selectedConversation = sampleConversations[0],
                messages = sampleMessages,
                totalMessages = sampleMessages.size,
            )
        )
        captureRoboImage("$OUT/conversation-detail-android.png") {
            LlamenosTheme(darkTheme = true) {
                ConversationDetailScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Contacts
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun contactsScreen() {
        val vm = mockk<ContactsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            ContactsUiState(
                contacts = sampleContacts,
                total = sampleContacts.size,
            )
        )
        captureRoboImage("$OUT/contacts-android.png") {
            LlamenosTheme(darkTheme = true) {
                ContactsScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shifts
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun shiftsScreen() {
        val vm = mockk<ShiftsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            ShiftsUiState(
                shifts = sampleShifts,
                clockedInAt = sampleTimestamp2,
            )
        )
        captureRoboImage("$OUT/shifts-android.png") {
            LlamenosTheme(darkTheme = true) {
                ShiftsScreen(viewModel = vm)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cases
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun casesScreen() {
        val vm = mockk<CaseManagementViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            CaseUiState(
                entityTypes = listOf(sampleEntityType),
                records = listOf(sampleRecord),
                recordsTotal = 1,
                selectedEntityTypeId = sampleEntityType.id,
            )
        )
        captureRoboImage("$OUT/cases-android.png") {
            LlamenosTheme(darkTheme = true) {
                CaseListScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                    onNavigateToCaseDetail = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reports
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun reportsScreen() {
        val vm = mockk<ReportsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            ReportsUiState(
                reports = sampleReports,
                total = sampleReports.size,
            )
        )
        captureRoboImage("$OUT/reports-android.png") {
            LlamenosTheme(darkTheme = true) {
                ReportsScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                    onNavigateToReportDetail = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun eventsScreen() {
        val vm = mockk<EventsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            EventsUiState(
                entityTypes = listOf(
                    sampleEntityType.copy(category = org.llamenos.protocol.SharedEntityTypeDefinitionCategory.Event, label = "Event", labelPlural = "Events")
                ),
                events = listOf(sampleRecord),
                total = 1,
            )
        )
        captureRoboImage("$OUT/events-android.png") {
            LlamenosTheme(darkTheme = true) {
                EventListScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                    onNavigateToEventDetail = {},
                    onNavigateToCreateEvent = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Triage
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun triageScreen() {
        val vm = mockk<TriageViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            TriageUiState(
                reports = sampleReports,
                total = sampleReports.size,
            )
        )
        captureRoboImage("$OUT/triage-android.png") {
            LlamenosTheme(darkTheme = true) {
                TriageScreen(
                    viewModel = vm,
                    onNavigateBack = {},
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun adminScreen() {
        val vm = mockk<AdminViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            AdminUiState(
                volunteers = sampleUsers,
                bans = sampleBans,
                auditEntries = sampleAuditEntries,
                auditTotal = sampleAuditEntries.size,
            )
        )
        captureRoboImage("$OUT/admin-android.png") {
            LlamenosTheme(darkTheme = true) {
                AdminScreen(
                    onNavigateBack = {},
                    viewModel = vm,
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Settings
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun settingsScreen() {
        captureRoboImage("$OUT/settings-android.png") {
            LlamenosTheme(darkTheme = true) {
                SettingsScreen(
                    signingPubkey = samplePubkey,
                    encryptionPubkey = samplePubkey2,
                    hubUrl = "https://llamenos.example.org",
                    connectionState = WebSocketService.ConnectionState.CONNECTED,
                    displayName = "Sarah Chen",
                    phone = "+1 (555) 867-5309",
                    selectedTheme = "dark",
                    onUpdateProfile = { _, _ -> },
                    onThemeChange = {},
                    selectedLanguage = "en",
                    onLanguageChange = {},
                    spokenLanguages = setOf("en", "es"),
                    onSpokenLanguagesChange = {},
                    notifyCalls = true,
                    notifyShifts = true,
                    notifyGeneral = false,
                    onNotifyCallsChange = {},
                    onNotifyShiftsChange = {},
                    onNotifyGeneralChange = {},
                    onLock = {},
                    onLogout = {},
                    onPanicWipe = {},
                    transcriptionEnabled = true,
                    transcriptionCanOptOut = true,
                    onTranscriptionChange = {},
                    autoLockMinutes = 5,
                    onAutoLockChange = {},
                    debugLogging = false,
                    onDebugLoggingChange = {},
                    onClearCache = {},
                    onNavigateToAdmin = {},
                    onNavigateToDeviceLink = {},
                )
            }
        }
    }

    @Test
    fun settingsScreenBiometricEnrolled() {
        captureRoboImage("$OUT/settings-biometric-enrolled-android.png") {
            LlamenosTheme(darkTheme = true) {
                SettingsScreen(
                    signingPubkey = samplePubkey,
                    encryptionPubkey = samplePubkey2,
                    hubUrl = "https://llamenos.example.org",
                    connectionState = WebSocketService.ConnectionState.CONNECTED,
                    displayName = "Sarah Chen",
                    phone = "+1 (555) 867-5309",
                    selectedTheme = "dark",
                    onUpdateProfile = { _, _ -> },
                    onThemeChange = {},
                    selectedLanguage = "en",
                    onLanguageChange = {},
                    spokenLanguages = setOf("en", "es"),
                    onSpokenLanguagesChange = {},
                    notifyCalls = true,
                    notifyShifts = true,
                    notifyGeneral = false,
                    onNotifyCallsChange = {},
                    onNotifyShiftsChange = {},
                    onNotifyGeneralChange = {},
                    onLock = {},
                    onLogout = {},
                    onPanicWipe = {},
                    transcriptionEnabled = true,
                    transcriptionCanOptOut = true,
                    onTranscriptionChange = {},
                    autoLockMinutes = 5,
                    onAutoLockChange = {},
                    debugLogging = false,
                    onDebugLoggingChange = {},
                    onClearCache = {},
                    onNavigateToAdmin = {},
                    onNavigateToDeviceLink = {},
                    biometricState = BiometricSectionState(enrolled = true),
                )
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Blasts
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun blastsScreen() {
        val vm = mockk<BlastsViewModel>(relaxed = true)
        every { vm.uiState } returns MutableStateFlow(
            BlastsUiState(
                blasts = listOf(
                    BlastItem(
                        id = "blast-001",
                        message = "Important shift reminder: Evening shift starts at 6 PM today. Please confirm availability.",
                        status = "sent",
                        recipientCount = 8,
                        createdAt = sampleTimestamp2,
                    ),
                    BlastItem(
                        id = "blast-002",
                        message = "Training session tomorrow at 10 AM via video call. Link sent via email.",
                        status = "sent",
                        recipientCount = 12,
                        createdAt = "2026-04-28T16:00:00Z",
                    ),
                    BlastItem(
                        id = "blast-003",
                        message = "All volunteers: Please update your availability for next week in the scheduling system.",
                        status = "scheduled",
                        recipientCount = 15,
                        createdAt = "2026-04-27T09:00:00Z",
                    ),
                ),
            )
        )
        captureRoboImage("$OUT/blasts-android.png") {
            LlamenosTheme(darkTheme = true) {
                BlastsScreen(
                    onNavigateBack = {},
                    viewModel = vm,
                )
            }
        }
    }
}
