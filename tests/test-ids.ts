/**
 * Centralized test ID constants for Playwright tests.
 *
 * These IDs are used with data-testid attributes in components and
 * getByTestId() in tests. Centralizing them ensures:
 * 1. Type safety - IDE autocomplete for test IDs
 * 2. Single source of truth - rename in one place
 * 3. Discoverability - all test IDs in one file
 *
 * Naming convention: SECTION_ELEMENT_ACTION
 * e.g., VOLUNTEER_ROW_DELETE, SHIFT_CARD_EDIT
 */

export const TestIds = {
  // ============ Page ============
  PAGE_TITLE: 'page-title',

  // ============ Navigation ============
  NAV_SIDEBAR: 'nav-sidebar',
  NAV_ADMIN_SECTION: 'nav-admin-section',
  NAV_DASHBOARD: 'nav-dashboard',
  NAV_NOTES: 'nav-notes',
  NAV_CONVERSATIONS: 'nav-conversations',
  NAV_REPORTS: 'nav-reports',
  NAV_BLASTS: 'nav-blasts',
  NAV_CALLS: 'nav-calls',
  NAV_SETTINGS: 'nav-settings',
  NAV_SHIFTS: 'nav-shifts',
  NAV_VOLUNTEERS: 'nav-users',
  NAV_BANS: 'nav-bans',
  NAV_CONTACTS: 'nav-contacts',
  NAV_AUDIT: 'nav-audit',
  NAV_ADMIN_SETTINGS: 'nav-admin-settings',
  NAV_ADMIN_HUBS: 'nav-admin-hubs',
  NAV_TRIAGE: 'nav-triage',
  NAV_HELP: 'nav-help',
  LOGOUT_BTN: 'logout-btn',
  SETTINGS_LOGOUT_BTN: 'settings-logout-btn',

  // ============ Volunteers ============
  VOLUNTEER_LIST: 'volunteer-list',
  VOLUNTEER_ROW: 'volunteer-row',
  VOLUNTEER_ADD_BTN: 'volunteer-add-btn',
  VOLUNTEER_DELETE_BTN: 'volunteer-delete-btn',
  VOLUNTEER_ROW_ROLE_SELECT: 'volunteer-row-role-select',
  VOLUNTEER_ROW_ROLE_OPTION: 'volunteer-row-role-option',
  VOLUNTEER_ROW_ROLE_BADGE: 'volunteer-row-role-badge',
  VOLUNTEER_ROW_NAME_LINK: 'volunteer-row-name-link',
  HUB_SWITCHER_TRIGGER: 'hub-switcher-trigger',
  HUB_SWITCHER_OPTION: 'hub-switcher-option',
  DELETE_HUB_CONFIRM_NAME: 'delete-hub-confirm-name',
  DELETE_HUB_CONFIRM_INPUT: 'delete-hub-confirm-input',
  USER_FORM_ROLE_SELECT: 'user-form-role-select',
  USER_FORM_ROLE_OPTION: 'user-form-role-option',
  VOLUNTEER_EDIT_BTN: 'volunteer-edit-btn',
  VOLUNTEER_DEVICE_KEY_CARD: 'volunteer-device-key-card',
  VOLUNTEER_DEVICE_KEY_CODE: 'volunteer-device-key-code',
  VOLUNTEER_INVITE_CARD: 'volunteer-invite-card',
  VOLUNTEER_INVITE_LINK: 'volunteer-invite-link',
  DISMISS_DEVICE_KEY: 'dismiss-device-key',
  DISMISS_INVITE: 'dismiss-invite',
  TOGGLE_PHONE_VISIBILITY: 'toggle-phone-visibility',
  INVITE_BTN: 'invite-btn',
  REVOKE_INVITE_BTN: 'revoke-invite-btn',

  // ============ Shifts ============
  SHIFT_LIST: 'shift-list',
  SHIFT_CARD: 'shift-card',
  SHIFT_CREATE_BTN: 'shift-create-btn',
  SHIFT_EDIT_BTN: 'shift-edit-btn',
  SHIFT_DELETE_BTN: 'shift-delete-btn',
  SHIFT_FORM: 'shift-form',
  SHIFT_NAME_INPUT: 'shift-name-input',
  SHIFT_START_TIME: 'shift-start-time',
  SHIFT_END_TIME: 'shift-end-time',
  SHIFT_VOLUNTEER_COUNT: 'shift-volunteer-count',
  FALLBACK_GROUP_CARD: 'fallback-group-card',

  // ============ Ban List ============
  BAN_LIST: 'ban-list',
  BAN_ROW: 'ban-row',
  BAN_ADD_BTN: 'ban-add-btn',
  BAN_IMPORT_BTN: 'ban-import-btn',
  BAN_REMOVE_BTN: 'ban-remove-btn',
  BAN_FORM: 'ban-form',
  BAN_BULK_FORM: 'ban-bulk-form',

  // ============ Notes ============
  NOTE_LIST: 'note-list',
  NOTE_CARD: 'note-card',
  NOTE_NEW_BTN: 'note-new-btn',
  NOTE_EDIT_BTN: 'note-edit-btn',
  NOTE_EDIT_INPUT: 'note-edit-input',
  NOTE_DETAIL_TEXT: 'note-detail-text',
  NOTE_SEARCH: 'note-search',
  NOTE_FORM: 'note-form',
  NOTE_CALL_ID: 'note-call-id',
  NOTE_CONTENT: 'note-content',
  NOTE_REPLY_BTN: 'note-reply-btn',
  NOTE_THREAD: 'note-thread',
  NOTE_REPLY_TEXT: 'note-reply-text',
  NOTE_REPLY_SEND: 'note-reply-send',
  NOTE_SHEET: 'note-sheet',
  SHEET_NOTE_TEXT: 'sheet-note-text',
  SHEET_SAVE_BTN: 'sheet-save-btn',

  // ============ Calls ============
  CALL_LIST: 'call-list',
  CALL_ROW: 'call-row',
  CALL_SEARCH: 'call-search',
  CALL_SEARCH_BTN: 'call-search-btn',
  CALL_CLEAR_FILTERS: 'call-clear-filters',
  CALL_DATE_FROM: 'call-date-from',
  CALL_DATE_TO: 'call-date-to',
  CALL_NOTES_LINK: 'call-notes-link',
  CALL_STATUS_FILTERS: 'call-status-filters',
  CALL_FILTER_ALL: 'call-filter-all',
  CALL_FILTER_COMPLETED: 'call-filter-completed',
  CALL_FILTER_UNANSWERED: 'call-filter-unanswered',
  RECORDING_BADGE: 'recording-badge',
  RECORDING_PLAYER: 'recording-player',
  RECORDING_PLAY_BTN: 'recording-play-btn',
  ACTIVE_CALL_PANEL: 'active-call-panel',
  /** Incoming (ringing) call row; append `-<callId>` via rowTestId */
  INCOMING_CALL_ROW: 'incoming-call-row',
  /** Answer button inside an incoming call row; append `-<callId>` via rowTestId */
  ANSWER_CALL_BTN: 'answer-call-btn',
  /** Hub label shown on a call when the user is a member of several hubs */
  CALL_HUB_LABEL: 'call-hub-label',
  CALL_TIMER: 'call-timer',
  BAN_BTN: 'ban-btn',
  BAN_REASON_INPUT: 'ban-reason-input',
  BAN_CONFIRM_BTN: 'ban-confirm-btn',

  // ============ Reports ============
  REPORT_LIST: 'report-list',
  REPORT_CARD: 'report-card',
  REPORT_NEW_BTN: 'report-new-btn',
  REPORT_CLOSE_BTN: 'close-report',
  REPORT_CLAIM_BTN: 'report-claim-btn',
  REPORT_DETAIL: 'report-detail',
  REPORT_TITLE_INPUT: 'report-title-input',
  REPORT_BODY_INPUT: 'report-body-input',
  REPORT_SUBMIT_BTN: 'report-form-submit-btn',
  REPORT_METADATA: 'report-metadata',
  REPORT_STATUS_BADGE: 'report-status-badge',
  REPORT_FILTER_AREA: 'report-filter-area',
  REPORT_TYPE_BADGE: 'report-type-badge',
  RECOVERY_KEY: 'recovery-key',

  // ============ Conversations ============
  CONVERSATION_LIST: 'conversation-list',
  CONVERSATION_ITEM: 'conversation-item',
  CONVERSATION_THREAD: 'conversation-thread',
  MESSAGE_COMPOSER: 'message-composer',
  CONV_ADD_NOTE_BTN: 'conv-add-note-btn',
  CONV_ASSIGN_BTN: 'conv-assign-btn',
  CONV_CLOSE_BTN: 'conv-close-btn',
  CONV_REOPEN_BTN: 'conv-reopen-btn',
  CONV_SEND_BTN: 'conv-send-btn',
  CONV_REASSIGN_BTN: 'conv-reassign-btn',
  CONV_SEARCH: 'conv-search',

  // ============ Contacts ============
  CONTACT_ROW: 'contact-row',

  // ============ Screen Pop (Epic 326) ============
  CONTACT_POPOVER: 'contact-popover',
  CONTACT_NAME: 'contact-name',
  CONTACT_CASE_COUNT: 'contact-case-count',
  LAST_INTERACTION_DATE: 'last-interaction-date',
  LINK_TO_CASE_DIALOG: 'link-to-case-dialog',
  LINK_CASE_CONFIRM: 'link-case-confirm',
  LINK_CASE_SKIP: 'link-case-skip',

  // ============ Blasts ============
  BLAST_LIST: 'blast-list',
  BLAST_CARD: 'blast-card',
  BLAST_NEW_BTN: 'blast-new-btn',
  BLAST_NAME: 'blast-name',
  BLAST_TEXT: 'blast-text',
  NO_BLASTS: 'no-blasts',

  // ============ Device Linking ============
  LINK_DEVICE_CARD: 'link-device-card',
  START_LINKING: 'start-linking',
  PROVISIONING_QR: 'provisioning-qr',
  SHORT_CODE: 'short-code',
  LINK_CODE_INPUT: 'link-code-input',
  LINK_DEVICE_BUTTON: 'link-device-button',
  CONTINUE_TO_LOGIN: 'continue-to-login',

  // ============ Auth / Login ============
  DEVICE_KEY_INPUT: 'device-key-input',
  LOGIN_SUBMIT_BTN: 'login-submit-btn',
  LOGIN_ERROR: 'login-error',
  GO_TO_SETUP_BTN: 'go-to-setup-btn',
  LOCK_BTN: 'lock-btn',
  RECOVERY_OPTIONS_BTN: 'recovery-options-btn',

  // ============ Security ============
  PANIC_WIPE_OVERLAY: 'panic-wipe-overlay',
  EMERGENCY_WIPE_BTN: 'emergency-wipe-btn',
  PIN_CHALLENGE_DIALOG: 'pin-challenge-dialog',
  PIN_CHALLENGE_ERROR: 'pin-challenge-error',
  PIN_CHALLENGE_LOCKOUT: 'pin-challenge-lockout',
  PIN_INPUT: 'pin-input',

  // ============ Audit ============
  AUDIT_ENTRY: 'audit-entry',
  AUDIT_SEARCH: 'audit-search',
  AUDIT_EVENT_FILTER: 'audit-event-filter',

  // ============ Roles ============
  ROLE_ROW: 'role-row',
  ROLE_CREATE_BTN: 'role-create-btn',
  ROLE_DELETE_BTN: 'role-delete-btn',

  // ============ Custom Fields ============
  CUSTOM_FIELD_ROW: 'custom-field-row',
  CUSTOM_FIELD_ADD_BTN: 'custom-field-add-btn',
  CUSTOM_FIELD_DELETE_BTN: 'custom-field-delete-btn',
  CUSTOM_FIELD_SECTION: 'custom-field-section',
  CUSTOM_FIELD_TYPE_SELECT: 'custom-field-type-select',
  CUSTOM_FIELD_ADD_OPTION_BTN: 'custom-field-add-option-btn',

  // ============ Conversation Filters ============
  CONV_FILTER_CHIP: 'conv-filter-chip',
  CONV_SECTION_HEADER: 'conv-section-header',

  // ============ Volunteer Profile ============
  VOLUNTEER_NAME: 'volunteer-name',
  VOLUNTEER_PUBKEY: 'volunteer-pubkey',
  VOLUNTEER_ROLE_BADGE: 'volunteer-role-badge',
  VOLUNTEER_STATUS_BADGE: 'volunteer-status-badge',
  VOLUNTEER_JOIN_DATE: 'volunteer-join-date',
  VOLUNTEER_ACTIVITY_CARD: 'volunteer-activity-card',

  // ============ Dashboard ============
  DASHBOARD_ACTIVE_CALLS: 'dashboard-active-calls',
  DASHBOARD_SHIFT_STATUS: 'dashboard-shift-status',
  DASHBOARD_CALLS_TODAY: 'dashboard-calls-today',
  DASHBOARD_QUICK_ACTIONS: 'dashboard-quick-actions',
  BREAK_TOGGLE_BTN: 'break-toggle-btn',

  // ============ Settings ============
  SETTINGS_SECTION: 'settings-section',
  SETTINGS_ADVANCED_SECTION: 'settings-advanced-section',
  SETTINGS_AUTO_LOCK: 'settings-auto-lock',
  SETTINGS_DEBUG_LOG: 'settings-debug-log',
  SETTINGS_CLEAR_CACHE: 'settings-clear-cache',
  TELEPHONY_PROVIDER: 'telephony-provider',
  PROVIDER_SELECT: 'provider-select',
  IN_APP_AUDIO_NOTICE: 'in-app-audio-notice',
  WEBRTC_ENABLED_SWITCH: 'webrtc-enabled-switch',
  ACCOUNT_SID: 'account-sid',
  AUTH_TOKEN: 'auth-token',
  API_KEY_SID: 'api-key-sid',
  TWIML_APP_SID: 'twiml-app-sid',
  RCS_AGENT_ID: 'rcs-agent-id',
  RCS_SERVICE_KEY: 'rcs-service-key',
  RCS_WEBHOOK_SECRET: 'rcs-webhook-secret',

  // ============ Settings Sections ============
  SETTINGS_CUSTOM_FIELDS: 'custom-fields',
  SETTINGS_TELEPHONY: 'telephony-provider',
  SETTINGS_TRANSCRIPTION: 'transcription',
  SETTINGS_SPAM: 'spam',
  SETTINGS_KEY_BACKUP: 'key-backup',
  SETTINGS_LINKED_DEVICES: 'linked-devices',
  SETTINGS_ADVANCED: 'advanced',
  SETTINGS_PROFILE: 'profile',
  SETTINGS_THEME: 'theme',
  SETTINGS_LANGUAGE: 'language',
  SETTINGS_NOTIFICATIONS: 'notifications',
  SETTINGS_PASSKEYS: 'passkeys',
  SETTINGS_HUB_CONNECTION: 'hub-connection',
  SETTINGS_CALL_PREFERENCE: 'call-preference',
  SETTINGS_CMS_TOGGLE: 'cms-toggle',
  SETTINGS_ENTITY_TYPES: 'entity-types',
  SETTINGS_TEMPLATES: 'templates',
  SETTINGS_REPORT_TYPES: 'report-types',
  SETTINGS_ACCOUNT_ERASURE: 'account-erasure',

  // ============ Theme ============
  THEME_SYSTEM: 'theme-system',
  THEME_LIGHT: 'theme-light',
  THEME_DARK: 'theme-dark',

  // ============ Admin Settings ============
  TRANSCRIPTION_SECTION: 'transcription',
  SPAM_SECTION: 'spam-section',

  // ============ Hub Onboarding ============
  HUB_ONBOARDING_WIZARD: 'hub-onboarding-wizard',
  HUB_ONBOARDING_STEP: 'hub-onboarding-step',
  HUB_ONBOARDING_NEXT: 'hub-onboarding-next',
  HUB_ONBOARDING_BACK: 'hub-onboarding-back',
  HUB_ONBOARDING_COMPLETE: 'hub-onboarding-complete',
  HUB_PROVIDER_SETTINGS: 'hub-provider-settings',
  HUB_USAGE_CARD: 'hub-usage-card',
  TEMPLATE_CARD_SCRATCH: 'template-card-scratch',
  CHANNEL_CHECKLIST: 'channel-checklist',
  RESTART_SETUP_BTN: 'restart-setup-btn',

  // ============ Setup Wizard ============
  SETUP_WIZARD: 'setup-wizard',
  SETUP_STEP: 'setup-step',
  SETUP_NEXT_BTN: 'setup-next-btn',
  SETUP_BACK_BTN: 'setup-back-btn',
  SETUP_SKIP_BTN: 'setup-skip-btn',
  DEMO_MODE_TOGGLE: 'demo-mode-toggle',

  // ============ Forms (Generic) ============
  FORM_SAVE_BTN: 'form-save-btn',
  FORM_CANCEL_BTN: 'form-cancel-btn',
  FORM_SUBMIT_BTN: 'form-submit-btn',

  // ============ Dialogs ============
  CONFIRM_DIALOG: 'confirm-dialog',
  CONFIRM_DIALOG_OK: 'confirm-dialog-ok',
  CONFIRM_DIALOG_CANCEL: 'confirm-dialog-cancel',

  // ============ Misc ============
  EMPTY_STATE: 'empty-state',
  LOADING_SKELETON: 'loading-skeleton',
  ERROR_MESSAGE: 'error-message',
  SUCCESS_TOAST: 'success-toast',
  IMPORT_CSV: 'import-csv',
  BACK_BTN: 'back-btn',

  // ============ Server Address (#738/#739) ============
  SERVER_ADDRESS_TITLE: 'server-address-title',
  SERVER_ADDRESS_INPUT: 'server-address-input',
  SERVER_ADDRESS_SUBMIT: 'server-address-submit',
  SERVER_ADDRESS_ERROR: 'server-address-error',
  SETTINGS_SERVER_ADDRESS_INPUT: 'settings-server-address-input',
  SETTINGS_SERVER_ADDRESS_SUBMIT: 'settings-server-address-submit',
  SETTINGS_SERVER_ADDRESS_ERROR: 'settings-server-address-error',

  // ============ Invite code entry (#1128/#1166) ============
  HAVE_INVITE_CODE_BTN: 'have-invite-code-btn',
  INVITE_CODE_INPUT: 'invite-code-input',
  INVITE_CODE_SUBMIT: 'invite-code-submit',
  INVITE_CODE_ERROR: 'invite-code-error',
  INVITE_CODE_CHANGE_SERVER: 'invite-code-change-server',
} as const

export type TestId = (typeof TestIds)[keyof typeof TestIds]

/**
 * Helper to create a data-testid selector string for use in tests.
 * Example: testId('volunteer-row') => '[data-testid="volunteer-row"]'
 */
export function testIdSelector(id: TestId): string {
  return `[data-testid="${id}"]`
}

/**
 * Helper to create a data-testid attribute value for a row item with an identifier.
 * Example: rowTestId('volunteer-row', 'abc123') => 'volunteer-row-abc123'
 */
export function rowTestId(baseId: TestId, identifier: string): string {
  return `${baseId}-${identifier}`
}

/**
 * Map from human-readable section names to their data-testid values.
 * SettingsSection components render with data-testid={id} where id is the section slug.
 * The trigger element within each section has data-testid="{id}-trigger".
 */
export const sectionTestIdMap: Record<string, string> = {
  'Custom Note Fields': TestIds.SETTINGS_CUSTOM_FIELDS,
  'Custom Fields': TestIds.SETTINGS_CUSTOM_FIELDS,
  'Telephony': TestIds.SETTINGS_TELEPHONY,
  'Telephony Provider': TestIds.SETTINGS_TELEPHONY,
  'Transcription': TestIds.SETTINGS_TRANSCRIPTION,
  'Spam Mitigation': TestIds.SETTINGS_SPAM,
  'Spam': TestIds.SETTINGS_SPAM,
  'Key Backup': TestIds.SETTINGS_KEY_BACKUP,
  'key backup': TestIds.SETTINGS_KEY_BACKUP,
  'Linked Devices': TestIds.SETTINGS_LINKED_DEVICES,
  'Device Link': TestIds.SETTINGS_LINKED_DEVICES,
  'Advanced Settings': TestIds.SETTINGS_ADVANCED,
  'Advanced': TestIds.SETTINGS_ADVANCED,
  'Profile': TestIds.SETTINGS_PROFILE,
  'Identity': TestIds.SETTINGS_PROFILE,
  'Theme': TestIds.SETTINGS_THEME,
  'Language': TestIds.SETTINGS_LANGUAGE,
  'Notifications': TestIds.SETTINGS_NOTIFICATIONS,
  'notifications': TestIds.SETTINGS_NOTIFICATIONS,
  'Passkeys': TestIds.SETTINGS_PASSKEYS,
  'Hub Connection': TestIds.SETTINGS_HUB_CONNECTION,
  'Call Preference': TestIds.SETTINGS_CALL_PREFERENCE,
  'CMS Toggle': TestIds.SETTINGS_CMS_TOGGLE,
  'Entity Types': TestIds.SETTINGS_ENTITY_TYPES,
  'Templates': TestIds.SETTINGS_TEMPLATES,
  'Report Types': TestIds.SETTINGS_REPORT_TYPES,
  'Account Erasure': TestIds.SETTINGS_ACCOUNT_ERASURE,
}

/**
 * Map from human-readable page names to their nav link test IDs.
 * Used by step definitions like "I navigate to the {string} page".
 */
export const navTestIdMap: Record<string, string> = {
  'Dashboard': 'nav-dashboard',
  'Notes': 'nav-notes',
  'Call Notes': 'nav-notes',
  'Conversations': 'nav-conversations',
  'Reports': 'nav-reports',
  'My Reports': 'nav-reports',
  'Blasts': 'nav-blasts',
  'Call History': 'nav-calls',
  'Calls': 'nav-calls',
  'Settings': 'nav-settings',
  'Shifts': 'nav-shifts',
  'Shift Schedule': 'nav-shifts',
  'Volunteers': 'nav-users',
  'Ban List': 'nav-bans',
  'Bans': 'nav-bans',
  'Contacts': 'nav-contacts',
  'Audit Log': 'nav-audit',
  'Hub Settings': 'nav-admin-settings',
  'Admin Settings': 'nav-admin-settings',
  'Hubs': 'nav-admin-hubs',
  'System Health': 'nav-admin-system',
  'Cases': 'nav-cases',
  'Contact Directory': 'nav-contacts-directory',
  'Events': 'nav-events',
  'Case Management': 'nav-admin-case-management',
  'Case Management Settings': 'nav-admin-case-management',
  'Triage': 'nav-triage',
  'Help': 'nav-help',
  // Spanish (es) nav labels
  'Panel': 'nav-dashboard',
  'Notas': 'nav-notes',
  'Notas de llamadas': 'nav-notes',
  'Conversaciones': 'nav-conversations',
  'Informes': 'nav-reports',
  'Difusiones': 'nav-blasts',
  'Historial de llamadas': 'nav-calls',
  'Configuración': 'nav-settings',
  'Turnos': 'nav-shifts',
  'Voluntarios': 'nav-volunteers',
  'Lista de bloqueo': 'nav-bans',
  'Contactos': 'nav-contacts',
  'Registro de auditoría': 'nav-audit',
  'Configuración del hub': 'nav-admin-settings',
  'Ayuda': 'nav-help',
}
