package org.llamenos.hotline.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import kotlinx.coroutines.flow.filterIsInstance
import org.llamenos.hotline.api.VersionChecker
import org.llamenos.hotline.ui.components.UpdateBanner
import org.llamenos.hotline.ui.components.UpdateRequiredScreen
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import org.llamenos.hotline.api.NetworkMonitor
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.service.OfflineQueue
import org.llamenos.hotline.ui.admin.AdminScreen
import org.llamenos.hotline.ui.admin.AdminSettingsScreenWithSidebar
import org.llamenos.hotline.ui.admin.AdminViewModel
import org.llamenos.hotline.ui.admin.SchemaBrowserScreen
import org.llamenos.hotline.ui.admin.ShiftDetailScreen
import org.llamenos.hotline.ui.admin.UserDetailScreen
import org.llamenos.hotline.ui.auth.AuthViewModel
import org.llamenos.hotline.ui.auth.InviteRedeemScreen
import org.llamenos.hotline.ui.auth.InviteStage
import org.llamenos.hotline.ui.auth.InviteViewModel
import org.llamenos.hotline.ui.calls.CallHistoryScreen
import org.llamenos.hotline.ui.calls.CallHistoryViewModel
import org.llamenos.hotline.ui.contacts.ContactsScreen
import org.llamenos.hotline.ui.contacts.ContactsViewModel
import org.llamenos.hotline.ui.contacts.ContactTimelineScreen
import org.llamenos.hotline.ui.contacts.ContactTimelineViewModel
import org.llamenos.hotline.ui.reports.ReportCreateScreen
import org.llamenos.hotline.ui.reports.ReportDetailScreen
import org.llamenos.hotline.ui.reports.ReportTypePickerScreen
import org.llamenos.hotline.ui.reports.ReportsScreen
import org.llamenos.hotline.ui.reports.ReportsViewModel
import org.llamenos.hotline.ui.reports.TypedReportCreateScreen
import org.llamenos.hotline.ui.auth.LoginScreen
import org.llamenos.hotline.ui.auth.OnboardingScreen
import org.llamenos.hotline.ui.auth.PINSetScreen
import org.llamenos.hotline.ui.auth.PINUnlockScreen
import org.llamenos.hotline.ui.conversations.ConversationDetailScreen
import org.llamenos.hotline.ui.messaging.BlastsScreen
import org.llamenos.hotline.ui.conversations.ConversationsViewModel
import org.llamenos.hotline.ui.help.HelpScreen
import org.llamenos.hotline.ui.notes.NoteCreateScreen
import org.llamenos.hotline.ui.notes.NoteDetailScreen
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.cases.CaseDetailScreen
import org.llamenos.hotline.ui.cases.CaseListScreen
import org.llamenos.hotline.ui.cases.CaseManagementViewModel
import org.llamenos.hotline.ui.events.CreateEventScreen
import org.llamenos.hotline.ui.events.EventDetailScreen
import org.llamenos.hotline.ui.events.EventListScreen
import org.llamenos.hotline.ui.events.EventsViewModel
import org.llamenos.hotline.ui.hubs.CreateHubScreen
import org.llamenos.hotline.ui.hubs.HubListScreen
import org.llamenos.hotline.ui.hubs.HubManagementViewModel
import org.llamenos.hotline.ui.hubsettings.HubCommunicationsScreen
import org.llamenos.hotline.ui.settings.DeviceLinkScreen
import org.llamenos.hotline.ui.settings.ErasureRequestScreen
import org.llamenos.hotline.ui.auth.DeviceWipeReceiptScreen
import org.llamenos.hotline.ui.contacts.ContactDetailScreen
import org.llamenos.hotline.ui.contacts.ContactDetailViewModel
import org.llamenos.hotline.ui.providersetup.APIKeyProviderScreen
import org.llamenos.hotline.ui.providersetup.OAuthProviderScreen
import org.llamenos.hotline.ui.providersetup.PhoneNumberScreen
import org.llamenos.hotline.ui.providersetup.ProviderSetupScreen
import org.llamenos.hotline.ui.providersetup.SignalRegistrationScreen
import org.llamenos.hotline.ui.providersetup.WebhookConfirmationScreen
import org.llamenos.hotline.ui.triage.TriageScreen
import org.llamenos.hotline.ui.triage.TriageDetailScreen
import org.llamenos.hotline.ui.triage.TriageViewModel
import org.llamenos.hotline.ui.security.DeviceListScreen
import org.llamenos.hotline.ui.security.SessionListScreen
import org.llamenos.hotline.ui.security.SecurityEventsScreen
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp

/**
 * Type-safe route definitions for the navigation graph.
 *
 * Each route is a sealed interface member with a unique [route] string.
 * This avoids raw string matching throughout the codebase.
 */
sealed interface LlamenosRoute {
    val route: String

    /** Hub URL input, device key import, or new identity creation. */
    data object Login : LlamenosRoute {
        override val route = "login"
    }

    /** Display generated device key for user to back up. */
    data object Onboarding : LlamenosRoute {
        override val route = "onboarding"
    }

    /** Set a new PIN (enter + confirm). */
    data object PINSet : LlamenosRoute {
        override val route = "pin_set"
    }

    /** Unlock with existing PIN. */
    data object PINUnlock : LlamenosRoute {
        override val route = "pin_unlock"
    }

    /** Redeem a validated invite with the device keys just created (enrolment). */
    data object InviteRedeem : LlamenosRoute {
        override val route = "invite_redeem"
    }

    /** Main screen with bottom navigation (Dashboard, Notes, Conversations, Shifts, Settings). */
    data object Main : LlamenosRoute {
        override val route = "main"
    }

    /** Note detail view. */
    data class NoteDetail(val noteId: String) : LlamenosRoute {
        override val route = "note/{noteId}"

        companion object {
            const val ROUTE_PATTERN = "note/{noteId}"
        }
    }

    /** Note creation form, optionally linked to a conversation or call. */
    data object NoteCreate : LlamenosRoute {
        override val route = "note_create"
        const val ROUTE_PATTERN = "note_create?conversationId={conversationId}&callId={callId}"
    }

    /** Conversation detail view. */
    data class ConversationDetail(val conversationId: String) : LlamenosRoute {
        override val route = "conversation/{conversationId}"

        companion object {
            const val ROUTE_PATTERN = "conversation/{conversationId}"
        }
    }

    /** Call history list. */
    data object CallHistory : LlamenosRoute {
        override val route = "call_history"
    }

    /** Reports list. */
    data object Reports : LlamenosRoute {
        override val route = "reports"
    }

    /** Report creation form (legacy, no report type). */
    data object ReportCreate : LlamenosRoute {
        override val route = "report_create"
    }

    /** Report type picker for template-driven report creation. */
    data object ReportTypePicker : LlamenosRoute {
        override val route = "report_type_picker"
    }

    /** Typed report creation form with template fields. */
    data class TypedReportCreate(val reportTypeId: String) : LlamenosRoute {
        override val route = "typed_report_create/$reportTypeId"

        companion object {
            const val ROUTE_PATTERN = "typed_report_create/{reportTypeId}"
        }
    }

    /** Contacts list. */
    data object Contacts : LlamenosRoute {
        override val route = "contacts"
    }

    /** Report detail view. */
    data class ReportDetail(val reportId: String) : LlamenosRoute {
        override val route = "report/{reportId}"

        companion object {
            const val ROUTE_PATTERN = "report/{reportId}"
        }
    }

    /** Contact timeline view. */
    data class ContactTimeline(val contactHash: String) : LlamenosRoute {
        override val route = "contact/{contactHash}"

        companion object {
            const val ROUTE_PATTERN = "contact/{contactHash}"
        }
    }

    /** Admin panel. */
    data object Admin : LlamenosRoute {
        override val route = "admin"
    }

    /** One admin section, opened from the admin sidebar drawer. */
    data class AdminSection(val section: String) : LlamenosRoute {
        override val route = "admin/section/$section"

        companion object {
            const val ROUTE_PATTERN = "admin/section/{${AdminViewModel.SECTION_ARG}}"
        }
    }

    /** Blasts (broadcast messages). */
    data object Blasts : LlamenosRoute {
        override val route = "blasts"
    }

    /** Help & Reference. */
    data object Help : LlamenosRoute {
        override val route = "help"
    }

    /** Volunteer detail/profile view. */
    data class VolunteerDetail(val pubkey: String) : LlamenosRoute {
        override val route = "volunteer/$pubkey"

        companion object {
            const val ROUTE_PATTERN = "volunteer/{pubkey}"
        }
    }

    /** Shift detail/assignment view. */
    data class ShiftDetail(val shiftId: String) : LlamenosRoute {
        override val route = "shift/$shiftId"

        companion object {
            const val ROUTE_PATTERN = "shift/{shiftId}"
        }
    }

    /** Device linking via QR code. */
    data object DeviceLink : LlamenosRoute {
        override val route = "device_link"
    }

    /** Case management list. */
    data object CaseList : LlamenosRoute {
        override val route = "cases"
    }

    /** Case detail view. */
    data class CaseDetail(val recordId: String) : LlamenosRoute {
        override val route = "case/$recordId"

        companion object {
            const val ROUTE_PATTERN = "case/{recordId}"
        }
    }

    /** Hub management list. */
    data object HubList : LlamenosRoute {
        override val route = "hubs"
    }

    /** Create a new hub. */
    data object HubCreate : LlamenosRoute {
        override val route = "hub_create"
    }

    /** Schema browser (read-only entity types). */
    data object SchemaBrowser : LlamenosRoute {
        override val route = "schema_browser"
    }

    /** Events list. */
    data object Events : LlamenosRoute {
        override val route = "events"
    }

    /** Event detail view. */
    data class EventDetail(val eventId: String) : LlamenosRoute {
        override val route = "event/$eventId"

        companion object {
            const val ROUTE_PATTERN = "event/{eventId}"
        }
    }

    /** Create a new event. */
    data object EventCreate : LlamenosRoute {
        override val route = "event_create"
    }

    /** Triage queue. */
    data object Triage : LlamenosRoute {
        override val route = "triage"
    }

    /** Triage report detail. */
    data class TriageDetail(val reportId: String) : LlamenosRoute {
        override val route = "triage/$reportId"

        companion object {
            const val ROUTE_PATTERN = "triage/{reportId}"
        }
    }

    /** Contact profile detail. */
    data class ContactDetail(val contactHash: String) : LlamenosRoute {
        override val route = "contact_detail/$contactHash"

        companion object {
            const val ROUTE_PATTERN = "contact_detail/{contactHash}"
        }
    }

    /** Provider setup screen. */
    data object ProviderSetup : LlamenosRoute {
        override val route = "provider_setup"
    }

    /** OAuth provider connection. */
    data class OAuthProvider(val providerName: String) : LlamenosRoute {
        override val route = "oauth_provider/$providerName"
        companion object {
            const val ROUTE_PATTERN = "oauth_provider/{providerName}"
        }
    }

    /** API key provider connection. */
    data class APIKeyProvider(val providerName: String) : LlamenosRoute {
        override val route = "api_key_provider/$providerName"
        companion object {
            const val ROUTE_PATTERN = "api_key_provider/{providerName}"
        }
    }

    /** Phone number management. */
    data class PhoneNumbers(val providerName: String) : LlamenosRoute {
        override val route = "phone_numbers/$providerName"
        companion object {
            const val ROUTE_PATTERN = "phone_numbers/{providerName}"
        }
    }

    /** Webhook confirmation. */
    data object WebhookConfirmation : LlamenosRoute {
        override val route = "webhook_confirmation"
    }

    /** Signal registration. */
    data object SignalRegistration : LlamenosRoute {
        override val route = "signal_registration"
    }

    /** Hub communications settings. */
    data object HubCommunications : LlamenosRoute {
        override val route = "hub_communications"
    }

    data object ErasureRequest : LlamenosRoute {
        override val route = "erasure_request"
    }

    data object DeviceWipe : LlamenosRoute {
        override val route = "device_wipe"
    }

    /** EP02: Device list (security tab). */
    data object SecurityDevices : LlamenosRoute {
        override val route = "security_devices"
    }

    /** EP02: Session list (security tab). */
    data object SecuritySessions : LlamenosRoute {
        override val route = "security_sessions"
    }

    /** EP02: Security events timeline. */
    data object SecurityEvents : LlamenosRoute {
        override val route = "security_events"
    }
}

/**
 * Routes that are shown while the device keys are locked (or before they exist). Every
 * other route shows unlocked content and is left as soon as the keys are dropped.
 */
private val AUTH_ROUTES = setOf(
    LlamenosRoute.Login.route,
    LlamenosRoute.Onboarding.route,
    LlamenosRoute.PINSet.route,
    LlamenosRoute.PINUnlock.route,
    LlamenosRoute.InviteRedeem.route,
)

/**
 * Root navigation composable for the llamenos app.
 *
 * Determines the start destination based on whether encrypted keys exist
 * in secure storage:
 * - Keys exist -> PINUnlock (user has previously set up)
 * - No keys -> Login (fresh install or after reset)
 *
 * The [AuthViewModel] is scoped to the NavHost so it survives screen
 * transitions within the auth flow. The [MainScreen] contains bottom
 * navigation with Dashboard, Notes, Conversations, Shifts, and Settings tabs.
 *
 * @param cryptoService Injected from [MainActivity] for determining auth state
 * @param webSocketService Injected for passing to MainScreen
 * @param keystoreService Injected for hub URL access in MainScreen
 */
@Composable
fun LlamenosNavigation(
    cryptoService: CryptoService,
    webSocketService: WebSocketService,
    keystoreService: KeystoreService,
    networkMonitor: NetworkMonitor,
    offlineQueue: OfflineQueue,
    versionChecker: VersionChecker,
    pendingDeepLink: DeepLinkDestination? = null,
    onDeepLinkConsumed: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val navController = rememberNavController()
    val authViewModel: AuthViewModel = hiltViewModel()
    val uiState by authViewModel.uiState.collectAsState()
    val inviteViewModel: InviteViewModel = hiltViewModel()
    val inviteState by inviteViewModel.uiState.collectAsState()

    // Version check state
    var versionStatus by remember { mutableStateOf<VersionChecker.VersionStatus>(VersionChecker.VersionStatus.Unknown) }
    var showUpdateBanner by remember { mutableStateOf(false) }

    // Check API version compatibility on first composition
    LaunchedEffect(Unit) {
        val status = versionChecker.check()
        versionStatus = status
        when (status) {
            is VersionChecker.VersionStatus.UpdateAvailable -> showUpdateBanner = true
            else -> { /* no banner */ }
        }
    }

    var isDeviceWiped by remember { mutableStateOf(false) }
    var deviceWipeReason by remember { mutableStateOf("") }
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        webSocketService.typedEvents
            .filterIsInstance<AttributedHubEvent<LlamenosEvent.DeviceWipe>>()
            .collect { attributed ->
                val wipeEvent = attributed.event
                // Clear ALL encrypted storage and AndroidKeyStore keys
                keystoreService.wipeAll()
                // Zeroize Rust crypto state (hub keys, server event keys, device keys)
                cryptoService.clearHubKeys()
                cryptoService.lock()
                // Clear transcription preferences (separate SharedPreferences instance)
                context.getSharedPreferences("transcription_prefs", android.content.Context.MODE_PRIVATE)
                    .edit().clear().apply()
                // Clear app cache directory
                context.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
                // Update UI
                isDeviceWiped = true
                deviceWipeReason = wipeEvent.reason
            }
    }

    if (isDeviceWiped) {
        DeviceWipeReceiptScreen(
            reason = deviceWipeReason,
            modifier = Modifier,
        )
        return
    }

    // Force-update screen blocks the entire app
    if (versionStatus is VersionChecker.VersionStatus.ForceUpdate) {
        val hubUrl = keystoreService.retrieve(KeystoreService.KEY_HUB_URL) ?: ""
        UpdateRequiredScreen(hubUrl = hubUrl)
        return
    }

    // Determine start destination based on stored key presence
    val startDestination = if (uiState.hasStoredKeys) {
        LlamenosRoute.PINUnlock.route
    } else {
        LlamenosRoute.Login.route
    }

    // Whatever dropped the device keys — the Lock button, Settings → Lock, the background
    // auto-lock — the unlocked screens go with them (#1339). Logout navigates to Login
    // itself and is already there by the time this runs.
    LaunchedEffect(navController) {
        cryptoService.unlockedState.collect { unlocked ->
            val route = navController.currentDestination?.route ?: return@collect
            if (unlocked || route in AUTH_ROUTES) return@collect
            authViewModel.onLocked()
            val target = if (keystoreService.contains(KeystoreService.KEY_ENCRYPTED_KEYS)) {
                LlamenosRoute.PINUnlock.route
            } else {
                LlamenosRoute.Login.route
            }
            navController.navigate(target) { popUpTo(0) { inclusive = true } }
        }
    }

    // A validated invite continues to PIN set, where the device keys are created.
    LaunchedEffect(inviteState.stage) {
        if (inviteState.stage == InviteStage.VALID &&
            navController.currentDestination?.route == LlamenosRoute.Login.route
        ) {
            navController.navigate(LlamenosRoute.PINSet.route) {
                popUpTo(LlamenosRoute.Login.route) { inclusive = false }
            }
        }
    }

    Column(modifier = modifier) {
        // Soft-update banner (dismissible)
        if (showUpdateBanner) {
            UpdateBanner(onDismiss = { showUpdateBanner = false })
        }

    NavHost(
        navController = navController,
        startDestination = startDestination,
    ) {
        composable(LlamenosRoute.Login.route) {
            LoginScreen(
                viewModel = authViewModel,
                onNavigateToPinSet = {
                    navController.navigate(LlamenosRoute.PINSet.route) {
                        popUpTo(LlamenosRoute.Login.route) { inclusive = false }
                    }
                },
                inviteState = inviteState,
                onInviteChange = { input ->
                    inviteViewModel.updateInput(input)
                    // An invite link names its hub; use it unless the user typed one.
                    val linkHub = InviteViewModel.parseInvite(input)?.hubUrl
                    if (linkHub != null && uiState.hubUrl.isBlank()) authViewModel.updateHubUrl(linkHub)
                },
                onSubmitInvite = inviteViewModel::validate,
            )
        }

        composable(LlamenosRoute.Onboarding.route) {
            OnboardingScreen(
                viewModel = authViewModel,
                onNavigateToPinSet = {
                    navController.navigate(LlamenosRoute.PINSet.route) {
                        // Clear onboarding from back stack -- device key should not be re-shown
                        popUpTo(LlamenosRoute.Onboarding.route) { inclusive = true }
                    }
                },
            )
        }

        composable(LlamenosRoute.PINSet.route) {
            PINSetScreen(
                viewModel = authViewModel,
                onAuthenticated = {
                    // Enrolling with an invite: register the new keys before entering the app.
                    val next = if (inviteState.stage == InviteStage.VALID) {
                        LlamenosRoute.InviteRedeem.route
                    } else {
                        LlamenosRoute.Main.route
                    }
                    navController.navigate(next) {
                        // Clear entire auth flow from back stack
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(LlamenosRoute.InviteRedeem.route) {
            InviteRedeemScreen(
                viewModel = inviteViewModel,
                onRedeemed = {
                    navController.navigate(LlamenosRoute.Main.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(LlamenosRoute.PINUnlock.route) {
            PINUnlockScreen(
                viewModel = authViewModel,
                onAuthenticated = {
                    navController.navigate(LlamenosRoute.Main.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onResetIdentity = {
                    navController.navigate(LlamenosRoute.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(LlamenosRoute.Main.route) {
            // Handle pending deep link after reaching the main authenticated screen
            LaunchedEffect(pendingDeepLink) {
                val destination = pendingDeepLink ?: return@LaunchedEffect
                onDeepLinkConsumed()
                when (destination) {
                    is DeepLinkDestination.Cases ->
                        navController.navigate(LlamenosRoute.CaseList.route)
                    is DeepLinkDestination.CaseDetail ->
                        navController.navigate("case/${destination.id}")
                    is DeepLinkDestination.Notes ->
                        { /* Already on main — user can tap Notes tab */ }
                    is DeepLinkDestination.NoteDetail ->
                        navController.navigate("note/${destination.id}")
                    is DeepLinkDestination.CallHistory ->
                        navController.navigate(LlamenosRoute.CallHistory.route)
                    is DeepLinkDestination.CallDetail ->
                        navController.navigate(LlamenosRoute.CallHistory.route)
                    is DeepLinkDestination.Conversations ->
                        { /* Already on main — user can tap Conversations tab */ }
                    is DeepLinkDestination.ConversationDetail ->
                        navController.navigate("conversation/${destination.id}")
                    is DeepLinkDestination.Reports ->
                        navController.navigate(LlamenosRoute.Reports.route)
                    is DeepLinkDestination.ReportDetail ->
                        navController.navigate("report/${destination.id}")
                    is DeepLinkDestination.Settings ->
                        { /* Already on main — user can tap Settings tab */ }
                    is DeepLinkDestination.Admin ->
                        navController.navigate(LlamenosRoute.Admin.route)
                }
            }
            MainScreen(
                cryptoService = cryptoService,
                webSocketService = webSocketService,
                keystoreService = keystoreService,
                networkMonitor = networkMonitor,
                offlineQueue = offlineQueue,
                // The unlockedState observer above moves the UI to the unlock screen.
                onLock = { cryptoService.lock() },
                onLogout = {
                    authViewModel.resetAuthState()
                    inviteViewModel.reset()
                    navController.navigate(LlamenosRoute.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onPanicWipe = {
                    authViewModel.resetAuthState()
                    inviteViewModel.reset()
                    navController.navigate(LlamenosRoute.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onNavigateToNoteDetail = { noteId ->
                    navController.navigate("note/$noteId")
                },
                onNavigateToNoteCreate = {
                    navController.navigate(LlamenosRoute.NoteCreate.route)
                },
                onNavigateToConversationDetail = { conversationId ->
                    navController.navigate("conversation/$conversationId")
                },
                onNavigateToAdmin = {
                    navController.navigate(LlamenosRoute.Admin.route)
                },
                onNavigateToCommunications = {
                    navController.navigate(LlamenosRoute.HubCommunications.route)
                },
                onNavigateToCallHistory = {
                    navController.navigate(LlamenosRoute.CallHistory.route)
                },
                onNavigateToReports = {
                    navController.navigate(LlamenosRoute.Reports.route)
                },
                onNavigateToContacts = {
                    navController.navigate(LlamenosRoute.Contacts.route)
                },
                onNavigateToCases = {
                    navController.navigate(LlamenosRoute.CaseList.route)
                },
                onNavigateToBlasts = {
                    navController.navigate(LlamenosRoute.Blasts.route)
                },
                onNavigateToHelp = {
                    navController.navigate(LlamenosRoute.Help.route)
                },
                onNavigateToDeviceLink = {
                    navController.navigate(LlamenosRoute.DeviceLink.route)
                },
                onNavigateToErasure = {
                    navController.navigate(LlamenosRoute.ErasureRequest.route)
                },
                onNavigateToHubs = {
                    navController.navigate(LlamenosRoute.HubList.route)
                },
                onNavigateToEvents = {
                    navController.navigate(LlamenosRoute.Events.route)
                },
                onNavigateToTriage = {
                    navController.navigate(LlamenosRoute.Triage.route)
                },
            )
        }

        composable(LlamenosRoute.NoteDetail.ROUTE_PATTERN) {
            val notesViewModel: NotesViewModel = hiltViewModel()
            NoteDetailScreen(
                viewModel = notesViewModel,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(
            LlamenosRoute.NoteCreate.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("conversationId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
                navArgument("callId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) { backStackEntry ->
            val notesViewModel: NotesViewModel = hiltViewModel()
            val conversationId = backStackEntry.arguments?.getString("conversationId")
            val callId = backStackEntry.arguments?.getString("callId")
            NoteCreateScreen(
                viewModel = notesViewModel,
                onNavigateBack = { navController.popBackStack() },
                conversationId = conversationId,
                callId = callId,
            )
        }

        composable(LlamenosRoute.ConversationDetail.ROUTE_PATTERN) {
            val conversationsViewModel: ConversationsViewModel = hiltViewModel()
            ConversationDetailScreen(
                viewModel = conversationsViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToNoteCreate = { conversationId ->
                    navController.navigate("note_create?conversationId=$conversationId")
                },
            )
        }

        // Sections replace one another above the admin panel, so back from any
        // section returns to the panel.
        val navigateToAdminSection: (String) -> Unit = { section ->
            navController.navigate(LlamenosRoute.AdminSection(section).route) {
                popUpTo(LlamenosRoute.Admin.route)
            }
        }

        composable(LlamenosRoute.Admin.route) {
            AdminScreen(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToVolunteerDetail = { pubkey ->
                    navController.navigate("volunteer/$pubkey")
                },
                onNavigateToShiftDetail = { shiftId ->
                    navController.navigate("shift/$shiftId")
                },
                onNavigateToSchemaBrowser = {
                    navController.navigate(LlamenosRoute.SchemaBrowser.route)
                },
                onNavigateToAdminSection = navigateToAdminSection,
            )
        }

        composable(LlamenosRoute.AdminSection.ROUTE_PATTERN) {
            AdminSettingsScreenWithSidebar(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToAdminSection = navigateToAdminSection,
            )
        }

        composable(LlamenosRoute.SchemaBrowser.route) {
            SchemaBrowserScreen(
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.VolunteerDetail.ROUTE_PATTERN) { backStackEntry ->
            val pubkey = backStackEntry.arguments?.getString("pubkey") ?: ""
            UserDetailScreen(
                pubkey = pubkey,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.ShiftDetail.ROUTE_PATTERN) { backStackEntry ->
            val shiftId = backStackEntry.arguments?.getString("shiftId") ?: ""
            ShiftDetailScreen(
                shiftId = shiftId,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.CallHistory.route) {
            val callHistoryViewModel: CallHistoryViewModel = hiltViewModel()
            CallHistoryScreen(
                viewModel = callHistoryViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToNoteCreate = { callId ->
                    navController.navigate("note_create?callId=$callId")
                },
            )
        }

        composable(LlamenosRoute.Reports.route) {
            val reportsViewModel: ReportsViewModel = hiltViewModel()
            ReportsScreen(
                viewModel = reportsViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToReportDetail = { reportId ->
                    navController.navigate("report/$reportId")
                },
                onNavigateToReportCreate = {
                    navController.navigate(LlamenosRoute.ReportCreate.route)
                },
                onNavigateToReportTypePicker = {
                    navController.navigate(LlamenosRoute.ReportTypePicker.route)
                },
            )
        }

        composable(LlamenosRoute.ReportCreate.route) {
            val reportsViewModel: ReportsViewModel = hiltViewModel()
            ReportCreateScreen(
                viewModel = reportsViewModel,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.ReportTypePicker.route) {
            val reportsViewModel: ReportsViewModel = hiltViewModel()
            ReportTypePickerScreen(
                viewModel = reportsViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToTypedReport = { reportTypeId ->
                    navController.navigate("typed_report_create/$reportTypeId")
                },
                onNavigateToLegacyReport = {
                    navController.navigate(LlamenosRoute.ReportCreate.route)
                },
            )
        }

        composable(
            LlamenosRoute.TypedReportCreate.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("reportTypeId") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val reportTypeId = backStackEntry.arguments?.getString("reportTypeId") ?: ""
            val reportsViewModel: ReportsViewModel = hiltViewModel()
            TypedReportCreateScreen(
                viewModel = reportsViewModel,
                reportTypeId = reportTypeId,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.ReportDetail.ROUTE_PATTERN) {
            val reportsViewModel: ReportsViewModel = hiltViewModel()
            ReportDetailScreen(
                viewModel = reportsViewModel,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.Contacts.route) {
            val contactsViewModel: ContactsViewModel = hiltViewModel()
            ContactsScreen(
                viewModel = contactsViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToTimeline = { contactHash ->
                    navController.navigate("contact/$contactHash")
                },
                onNavigateToDetail = { contactHash ->
                    navController.navigate("contact_detail/$contactHash")
                },
            )
        }

        composable(
            LlamenosRoute.ContactDetail.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("contactHash") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val contactHash = backStackEntry.arguments?.getString("contactHash") ?: ""
            val contactDetailViewModel: ContactDetailViewModel = hiltViewModel()
            LaunchedEffect(contactHash) {
                contactDetailViewModel.loadContact(contactHash)
            }
            ContactDetailScreen(
                viewModel = contactDetailViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToTimeline = { hash ->
                    navController.navigate("contact/$hash")
                },
            )
        }

        composable(LlamenosRoute.ContactTimeline.ROUTE_PATTERN) { backStackEntry ->
            val contactHash = backStackEntry.arguments?.getString("contactHash") ?: ""
            val timelineViewModel: ContactTimelineViewModel = hiltViewModel()
            LaunchedEffect(contactHash) {
                timelineViewModel.loadTimeline(contactHash)
            }
            ContactTimelineScreen(
                viewModel = timelineViewModel,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.Triage.route) {
            val triageViewModel: TriageViewModel = hiltViewModel()
            TriageScreen(
                viewModel = triageViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToDetail = { reportId ->
                    navController.navigate("triage/$reportId")
                },
            )
        }

        composable(
            LlamenosRoute.TriageDetail.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("reportId") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val reportId = backStackEntry.arguments?.getString("reportId") ?: ""
            val triageViewModel: TriageViewModel = hiltViewModel()
            LaunchedEffect(reportId) {
                triageViewModel.loadReportById(reportId)
            }
            TriageDetailScreen(
                viewModel = triageViewModel,
                reportId = reportId,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.Blasts.route) {
            BlastsScreen(
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.Help.route) {
            HelpScreen(
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.DeviceLink.route) {
            DeviceLinkScreen(
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.CaseList.route) {
            val caseViewModel: CaseManagementViewModel = hiltViewModel()
            CaseListScreen(
                viewModel = caseViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToCaseDetail = { recordId ->
                    navController.navigate("case/$recordId")
                },
            )
        }

        composable(
            LlamenosRoute.CaseDetail.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("recordId") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val recordId = backStackEntry.arguments?.getString("recordId") ?: ""
            val caseViewModel: CaseManagementViewModel = hiltViewModel()
            CaseDetailScreen(
                viewModel = caseViewModel,
                recordId = recordId,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.HubList.route) {
            val hubViewModel: HubManagementViewModel = hiltViewModel()
            HubListScreen(
                viewModel = hubViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToCreateHub = {
                    navController.navigate(LlamenosRoute.HubCreate.route)
                },
            )
        }

        composable(LlamenosRoute.HubCreate.route) {
            val hubViewModel: HubManagementViewModel = hiltViewModel()
            CreateHubScreen(
                viewModel = hubViewModel,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.Events.route) {
            val eventsViewModel: EventsViewModel = hiltViewModel()
            EventListScreen(
                viewModel = eventsViewModel,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToEventDetail = { eventId ->
                    navController.navigate("event/$eventId")
                },
                onNavigateToCreateEvent = {
                    navController.navigate(LlamenosRoute.EventCreate.route)
                },
            )
        }

        composable(
            LlamenosRoute.EventDetail.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("eventId") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val eventId = backStackEntry.arguments?.getString("eventId") ?: ""
            val eventsViewModel: EventsViewModel = hiltViewModel()
            EventDetailScreen(
                viewModel = eventsViewModel,
                eventId = eventId,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.EventCreate.route) {
            val eventsViewModel: EventsViewModel = hiltViewModel()
            CreateEventScreen(
                viewModel = eventsViewModel,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.ProviderSetup.route) {
            ProviderSetupScreen(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToOAuth = { provider ->
                    navController.navigate("oauth_provider/$provider")
                },
                onNavigateToApiKey = { provider ->
                    navController.navigate("api_key_provider/$provider")
                },
                onNavigateToPhoneNumbers = { provider ->
                    navController.navigate("phone_numbers/$provider")
                },
                onNavigateToSignalRegistration = {
                    navController.navigate(LlamenosRoute.SignalRegistration.route)
                },
            )
        }

        composable(
            LlamenosRoute.OAuthProvider.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("providerName") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val providerName = backStackEntry.arguments?.getString("providerName") ?: ""
            OAuthProviderScreen(
                provider = providerName,
                onNavigateBack = { navController.popBackStack() },
                onOAuthComplete = { success, _ ->
                    if (success) {
                        navController.popBackStack()
                    }
                },
            )
        }

        composable(
            LlamenosRoute.APIKeyProvider.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("providerName") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val providerName = backStackEntry.arguments?.getString("providerName") ?: ""
            APIKeyProviderScreen(
                provider = providerName,
                onNavigateBack = { navController.popBackStack() },
                onConfigured = { navController.popBackStack() },
            )
        }

        composable(
            LlamenosRoute.PhoneNumbers.ROUTE_PATTERN,
            arguments = listOf(
                navArgument("providerName") {
                    type = NavType.StringType
                },
            ),
        ) { backStackEntry ->
            val providerName = backStackEntry.arguments?.getString("providerName") ?: ""
            PhoneNumberScreen(
                provider = providerName,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.WebhookConfirmation.route) {
            val webhookBaseUrl = keystoreService.retrieve(KeystoreService.KEY_HUB_URL) ?: ""
            WebhookConfirmationScreen(
                provider = "twilio",
                phoneNumber = "",
                webhookBaseUrl = webhookBaseUrl,
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.SignalRegistration.route) {
            SignalRegistrationScreen(
                onNavigateBack = { navController.popBackStack() },
            )
        }

        composable(LlamenosRoute.HubCommunications.route) {
            HubCommunicationsScreen(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToProviderSetup = {
                    navController.navigate(LlamenosRoute.ProviderSetup.route)
                },
                onNavigateToPhoneNumbers = { provider ->
                    navController.navigate("phone_numbers/$provider")
                },
            )
        }

        composable(LlamenosRoute.ErasureRequest.route) {
            ErasureRequestScreen(
                modifier = Modifier.padding(0.dp),
            )
        }

        composable(LlamenosRoute.DeviceWipe.route) {
            DeviceWipeReceiptScreen(
                reason = "",
                modifier = Modifier.padding(0.dp),
            )
        }

        // EP02: Security screens

        composable(LlamenosRoute.SecurityDevices.route) {
            DeviceListScreen(
                devices = emptyList(),
                loading = true,
            )
        }

        composable(LlamenosRoute.SecuritySessions.route) {
            SessionListScreen(
                sessions = emptyList(),
                loading = true,
            )
        }

        composable(LlamenosRoute.SecurityEvents.route) {
            SecurityEventsScreen(
                events = emptyList(),
                loading = true,
                total = 0,
            )
        }
    }
    } // Column
}
