package org.llamenos.hotline.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R
import org.llamenos.hotline.api.NetworkMonitor
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.service.OfflineQueue
import org.llamenos.hotline.ui.components.DemoBanner
import org.llamenos.hotline.ui.components.DemoBannerViewModel
import org.llamenos.hotline.ui.components.OfflineBanner
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.ui.conversations.ConversationsScreen
import org.llamenos.hotline.ui.conversations.ConversationsViewModel
import org.llamenos.hotline.ui.dashboard.DashboardScreen
import org.llamenos.hotline.ui.dashboard.DashboardViewModel
import org.llamenos.hotline.ui.hubs.HubSelectionViewModel
import org.llamenos.hotline.ui.notes.NotesScreen
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.settings.BiometricSectionEvent
import org.llamenos.hotline.ui.settings.BiometricSectionState
import org.llamenos.hotline.ui.settings.BiometricSettingsViewModel
import org.llamenos.hotline.ui.settings.SettingsScreen
import org.llamenos.hotline.ui.shifts.ShiftsScreen
import org.llamenos.hotline.ui.shifts.ShiftsViewModel

/**
 * Bottom navigation tab definitions.
 *
 * Each tab has an icon, label resource, and test tag. The [ordinal] order
 * determines the tab position in the bottom navigation bar.
 */
private enum class MainTab(
    val icon: ImageVector,
    val labelRes: Int,
    val testTagValue: String,
) {
    DASHBOARD(Icons.Filled.Home, R.string.nav_dashboard, "nav-dashboard"),
    NOTES(Icons.Filled.Description, R.string.nav_notes, "nav-notes"),
    CONVERSATIONS(Icons.Filled.Chat, R.string.nav_conversations, "nav-conversations"),
    SHIFTS(Icons.Filled.CalendarMonth, R.string.nav_shifts, "nav-shifts"),
    SETTINGS(Icons.Filled.Settings, R.string.nav_settings, "nav-settings"),
}

/**
 * Main screen with Material 3 bottom navigation.
 *
 * This composable is shown after successful authentication and contains
 * five tabs: Dashboard, Notes, Conversations, Shifts, and Settings.
 * Each tab maintains its own ViewModel and state independently.
 *
 * The selected tab index survives configuration changes (rotation) via
 * [rememberSaveable]. The NavController for note detail/create is passed
 * through from the parent navigation graph.
 *
 * @param cryptoService Injected crypto service for identity info
 * @param webSocketService Injected WebSocket service for connection state
 * @param keystoreService Injected keystore for hub URL
 * @param onLock Callback to lock the app (clears key from memory)
 * @param onLogout Callback to fully logout (clears all data)
 * @param onNavigateToNoteDetail Callback to navigate to note detail screen
 * @param onNavigateToNoteCreate Callback to navigate to note create screen
 * @param onNavigateToConversationDetail Callback to navigate to conversation detail screen
 * @param onNavigateToAdmin Callback to navigate to admin panel
 * @param onNavigateToDeviceLink Callback to navigate to device linking screen
 */
@Composable
fun MainScreen(
    cryptoService: CryptoService,
    webSocketService: WebSocketService,
    keystoreService: KeystoreService,
    networkMonitor: NetworkMonitor,
    offlineQueue: OfflineQueue,
    onLock: () -> Unit,
    onLogout: () -> Unit,
    onPanicWipe: () -> Unit,
    onNavigateToNoteDetail: (String) -> Unit,
    onNavigateToNoteCreate: () -> Unit,
    onNavigateToConversationDetail: (String) -> Unit,
    onNavigateToAdmin: () -> Unit,
    onNavigateToCommunications: () -> Unit = {},
    onNavigateToCallHistory: () -> Unit,
    onNavigateToReports: () -> Unit,
    onNavigateToContacts: () -> Unit,
    onNavigateToCases: () -> Unit,
    onNavigateToBlasts: () -> Unit,
    onNavigateToHelp: () -> Unit,
    onNavigateToDeviceLink: () -> Unit,
    onNavigateToErasure: () -> Unit = {},
    onNavigateToHubs: () -> Unit = {},
    onNavigateToEvents: () -> Unit = {},
    onNavigateToTriage: () -> Unit = {},
    onNavigateToSecurityDevices: () -> Unit = {},
    onNavigateToSecuritySessions: () -> Unit = {},
    onNavigateToSecurityEvents: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var selectedTab by rememberSaveable { mutableIntStateOf(0) }
    val connectionState by webSocketService.connectionState.collectAsState()

    // ViewModels scoped to this composable's lifecycle
    val dashboardViewModel: DashboardViewModel = hiltViewModel()
    val notesViewModel: NotesViewModel = hiltViewModel()
    val conversationsViewModel: ConversationsViewModel = hiltViewModel()
    val shiftsViewModel: ShiftsViewModel = hiltViewModel()
    val demoBannerViewModel: DemoBannerViewModel = hiltViewModel()
    val demoBannerUiState by demoBannerViewModel.uiState.collectAsState()
    val biometricSettingsViewModel: BiometricSettingsViewModel = hiltViewModel()
    val biometricSettingsUiState by biometricSettingsViewModel.uiState.collectAsState()
    // Picks the hub to browse when none is chosen yet (#1340); refreshed by pull-to-refresh.
    val hubSelectionViewModel: HubSelectionViewModel = hiltViewModel()

    // Unread count for conversations badge
    val conversationsUiState by conversationsViewModel.uiState.collectAsState()
    val unreadCount = conversationsUiState.totalUnread

    Scaffold(
        bottomBar = {
            NavigationBar(
                modifier = Modifier.testTag("bottom-nav"),
            ) {
                MainTab.entries.forEachIndexed { index, tab ->
                    NavigationBarItem(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        icon = {
                            if (tab == MainTab.CONVERSATIONS && unreadCount > 0) {
                                BadgedBox(
                                    badge = {
                                        Badge(
                                            modifier = Modifier.testTag("conversations-badge"),
                                        ) {
                                            Text(
                                                text = if (unreadCount > 99) "99+" else unreadCount.toString(),
                                            )
                                        }
                                    },
                                ) {
                                    Icon(
                                        imageVector = tab.icon,
                                        contentDescription = stringResource(tab.labelRes),
                                    )
                                }
                            } else {
                                Icon(
                                    imageVector = tab.icon,
                                    contentDescription = stringResource(tab.labelRes),
                                )
                            }
                        },
                        label = { Text(stringResource(tab.labelRes)) },
                        modifier = Modifier.testTag(tab.testTagValue),
                    )
                }
            }
        },
        modifier = modifier,
    ) { paddingValues ->
        Column(modifier = Modifier.padding(paddingValues)) {
            OfflineBanner(networkMonitor, offlineQueue)

            if (demoBannerUiState.visible) {
                DemoBanner(
                    onDismiss = demoBannerViewModel::dismiss,
                    demoResetSchedule = demoBannerUiState.demoResetSchedule,
                )
            }

            when (MainTab.entries[selectedTab]) {
                MainTab.DASHBOARD -> {
                    DashboardScreen(
                        viewModel = dashboardViewModel,
                        notesViewModel = notesViewModel,
                        onLock = onLock,
                        onLogout = onLogout,
                        onNavigateToNotes = { selectedTab = MainTab.NOTES.ordinal },
                        onNavigateToNoteDetail = onNavigateToNoteDetail,
                        onNavigateToCallHistory = onNavigateToCallHistory,
                        onNavigateToReports = onNavigateToReports,
                        onNavigateToContacts = onNavigateToContacts,
                        onNavigateToCases = onNavigateToCases,
                        onNavigateToBlasts = onNavigateToBlasts,
                        onNavigateToHelp = onNavigateToHelp,
                        onNavigateToHubs = onNavigateToHubs,
                        onNavigateToEvents = onNavigateToEvents,
                        onNavigateToTriage = onNavigateToTriage,
                        onRefresh = hubSelectionViewModel::refresh,
                    )
                }

                MainTab.NOTES -> {
                    NotesScreen(
                        viewModel = notesViewModel,
                        onNavigateToCreate = onNavigateToNoteCreate,
                        onNavigateToDetail = onNavigateToNoteDetail,
                    )
                }

                MainTab.CONVERSATIONS -> {
                    ConversationsScreen(
                        viewModel = conversationsViewModel,
                        onNavigateToDetail = onNavigateToConversationDetail,
                    )
                }

                MainTab.SHIFTS -> {
                    ShiftsScreen(
                        viewModel = shiftsViewModel,
                    )
                }

                MainTab.SETTINGS -> {
                    SettingsScreen(
                        signingPubkey = cryptoService.signingPubkeyHex ?: "",
                        encryptionPubkey = cryptoService.encryptionPubkeyHex ?: "",
                        hubUrl = keystoreService.retrieve(KeystoreService.KEY_HUB_URL) ?: "",
                        connectionState = connectionState,
                        displayName = keystoreService.retrieve("display_name") ?: "",
                        phone = keystoreService.retrieve("phone") ?: "",
                        selectedTheme = keystoreService.retrieve("theme") ?: "system",
                        onUpdateProfile = { name, phone ->
                            keystoreService.store("display_name", name)
                            keystoreService.store("phone", phone)
                        },
                        onThemeChange = { theme ->
                            keystoreService.store("theme", theme)
                        },
                        selectedLanguage = keystoreService.retrieve("language") ?: "en",
                        onLanguageChange = { lang ->
                            keystoreService.store("language", lang)
                        },
                        spokenLanguages = (keystoreService.retrieve("spoken_languages") ?: "")
                            .split(",").filter { it.isNotBlank() }.toSet(),
                        onSpokenLanguagesChange = { langs ->
                            keystoreService.store("spoken_languages", langs.joinToString(","))
                        },
                        notifyCalls = (keystoreService.retrieve("notify_calls") ?: "true") == "true",
                        notifyShifts = (keystoreService.retrieve("notify_shifts") ?: "true") == "true",
                        notifyGeneral = (keystoreService.retrieve("notify_general") ?: "true") == "true",
                        onNotifyCallsChange = { keystoreService.store("notify_calls", it.toString()) },
                        onNotifyShiftsChange = { keystoreService.store("notify_shifts", it.toString()) },
                        onNotifyGeneralChange = { keystoreService.store("notify_general", it.toString()) },
                        transcriptionEnabled = (keystoreService.retrieve("transcription_enabled") ?: "true") == "true",
                        transcriptionCanOptOut = (keystoreService.retrieve("transcription_can_optout") ?: "true") == "true",
                        onTranscriptionChange = { keystoreService.store("transcription_enabled", it.toString()) },
                        autoLockMinutes = (keystoreService.retrieve("auto_lock_minutes") ?: "5").toIntOrNull() ?: 5,
                        onAutoLockChange = { keystoreService.store("auto_lock_minutes", it.toString()) },
                        debugLogging = (keystoreService.retrieve("debug_logging") ?: "false") == "true",
                        onDebugLoggingChange = { keystoreService.store("debug_logging", it.toString()) },
                        onClearCache = {
                            // Clear non-essential cached data
                            keystoreService.clearCache()
                        },
                        onLock = onLock,
                        onLogout = onLogout,
                        onPanicWipe = onPanicWipe,
                        onNavigateToCommunications = onNavigateToCommunications,
                        onNavigateToAdmin = onNavigateToAdmin,
                        onNavigateToDeviceLink = onNavigateToDeviceLink,
                        onNavigateToErasure = onNavigateToErasure,
                        biometricState = BiometricSectionState(
                            enrolled = biometricSettingsUiState.isEnrolled,
                            verifyingPin = biometricSettingsUiState.isVerifyingPin,
                            pinError = biometricSettingsUiState.pinError,
                            statusMessage = biometricSettingsUiState.statusMessage,
                            enrollCipher = biometricSettingsUiState.enrollCipher,
                        ),
                        onBiometricEvent = { event ->
                            when (event) {
                                is BiometricSectionEvent.SubmitPin ->
                                    biometricSettingsViewModel.beginEnrollment(event.pin)
                                is BiometricSectionEvent.DismissPinDialog ->
                                    biometricSettingsViewModel.cancelEnrollment()
                                is BiometricSectionEvent.EnrollSucceeded ->
                                    biometricSettingsViewModel.completeEnrollment(event.cipher)
                                is BiometricSectionEvent.EnrollCancelled ->
                                    biometricSettingsViewModel.cancelEnrollment()
                                is BiometricSectionEvent.Disable ->
                                    biometricSettingsViewModel.unenroll()
                            }
                        },
                    )
                }
            }
        }
    }
}
