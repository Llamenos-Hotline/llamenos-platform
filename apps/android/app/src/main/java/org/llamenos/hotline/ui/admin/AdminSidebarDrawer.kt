package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.llamenos.hotline.R

/**
 * Wraps an admin screen in the admin sidebar drawer.
 *
 * [content] receives the action that opens the drawer, for the screen's
 * [AdminSidebarToggle]. Picking an item closes the drawer and then hands its
 * slug to [onNavigateToAdminSection]; picking the section already shown just
 * closes it. The drawer opens only from the toggle, so edge swipes stay with
 * the screen's own scrollables; back closes an open drawer before it leaves
 * the screen.
 */
@Composable
fun AdminSidebarDrawerHost(
    selectedSlug: String?,
    onNavigateToAdminSection: (String) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = drawerState.isOpen,
        drawerContent = {
            AdminSidebarDrawer(
                drawerState = drawerState,
                selectedSlug = selectedSlug,
                onItemClick = { slug ->
                    scope.launch {
                        drawerState.close()
                        if (slug != selectedSlug) onNavigateToAdminSection(slug)
                    }
                },
            )
        },
        modifier = modifier,
    ) {
        content { scope.launch { drawerState.open() } }
    }
}

/** Top-bar action that opens the admin sidebar drawer. */
@Composable
fun AdminSidebarToggle(onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.testTag("admin-sidebar-toggle"),
    ) {
        Icon(
            imageVector = Icons.Filled.Menu,
            contentDescription = stringResource(R.string.admin_nav_open_menu),
        )
    }
}

@Composable
fun AdminSidebarDrawer(
    drawerState: DrawerState,
    selectedSlug: String?,
    onItemClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    ModalDrawerSheet(drawerState = drawerState, modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .padding(horizontal = 12.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            AdminSidebarScopeHeader(
                text = stringResource(R.string.admin_nav_scopes_this_hub),
                testTag = "admin-sidebar-scope-hub",
            )
            AdminSidebarItems(AdminNavConfig.thisHubItems, selectedSlug, onItemClick)

            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

            AdminSidebarScopeHeader(
                text = stringResource(R.string.admin_nav_scopes_platform),
                testTag = "admin-sidebar-scope-platform",
            )
            AdminSidebarItems(AdminNavConfig.platformItems, selectedSlug, onItemClick)
        }
    }
}

@Composable
private fun AdminSidebarScopeHeader(text: String, testTag: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag(testTag),
    )
}

@Composable
private fun AdminSidebarItems(
    items: List<AdminNavItem>,
    selectedSlug: String?,
    onItemClick: (String) -> Unit,
) {
    items.forEach { item ->
        NavigationDrawerItem(
            label = { Text(stringResource(item.labelRes)) },
            selected = item.slug == selectedSlug,
            onClick = { onItemClick(item.slug) },
            modifier = Modifier.testTag(item.testTag),
        )
    }
}

data class AdminNavItem(
    val slug: String,
    val labelRes: Int,
    val testTag: String,
    val requiredPermissions: List<String> = emptyList(),
    val requiredRole: String? = null,
)

object AdminNavConfig {
    val thisHubItems = listOf(
        AdminNavItem("location-lookup", R.string.admin_nav_items_location_lookup, "admin-sidebar-item-location-lookup", listOf("settings:read")),
        AdminNavItem("passkey-policy", R.string.admin_nav_items_passkey_policy, "admin-sidebar-item-passkey-policy", listOf("settings:read")),
        AdminNavItem("recovery-group", R.string.admin_nav_items_recovery_group, "admin-sidebar-item-recovery-group", listOf("settings:read")),
        AdminNavItem("devices", R.string.admin_nav_items_devices, "admin-sidebar-item-devices", listOf("settings:read")),
        AdminNavItem("hub-roles", R.string.admin_nav_items_hub_roles, "admin-sidebar-item-hub-roles", listOf("settings:read")),
        AdminNavItem("teams", R.string.admin_nav_items_teams, "admin-sidebar-item-teams", listOf("settings:read")),
        AdminNavItem("tags", R.string.admin_nav_items_tags, "admin-sidebar-item-tags", listOf("settings:read")),
        AdminNavItem("custom-fields", R.string.admin_nav_items_custom_fields, "admin-sidebar-item-custom-fields", listOf("settings:read")),
        AdminNavItem("report-types", R.string.admin_nav_items_report_types, "admin-sidebar-item-report-types", listOf("settings:read")),
        AdminNavItem("firehose", R.string.admin_nav_items_firehose, "admin-sidebar-item-firehose", listOf("settings:read")),
        AdminNavItem("call-settings", R.string.admin_nav_items_call_settings, "admin-sidebar-item-call-settings", listOf("settings:read")),
        AdminNavItem("voice-prompts", R.string.admin_nav_items_voice_prompts, "admin-sidebar-item-voice-prompts", listOf("settings:read")),
        AdminNavItem("phone-menu-languages", R.string.admin_nav_items_phone_menu_languages, "admin-sidebar-item-phone-menu-languages", listOf("settings:read")),
        AdminNavItem("transcription", R.string.admin_nav_items_transcription, "admin-sidebar-item-transcription", listOf("settings:read")),
        AdminNavItem("spam-protection", R.string.admin_nav_items_spam_protection, "admin-sidebar-item-spam-protection", listOf("settings:read")),
        AdminNavItem("phone-provider", R.string.admin_nav_items_phone_provider, "admin-sidebar-item-phone-provider", listOf("settings:read")),
        AdminNavItem("messaging-sms", R.string.admin_nav_items_messaging_sms, "admin-sidebar-item-messaging-sms", listOf("settings:read")),
        AdminNavItem("rcs", R.string.admin_nav_items_rcs, "admin-sidebar-item-rcs", listOf("settings:read")),
        AdminNavItem("signal", R.string.admin_nav_items_signal, "admin-sidebar-item-signal", listOf("settings:read")),
        AdminNavItem("bans", R.string.admin_nav_items_bans, "admin-sidebar-item-bans", listOf("bans:read")),
        AdminNavItem("erasure-queue", R.string.admin_nav_items_erasure_queue, "admin-sidebar-item-erasure-queue", listOf("erasure:admin")),
        AdminNavItem("retention", R.string.admin_nav_items_retention_settings, "admin-sidebar-item-retention", listOf("retention:manage")),
        AdminNavItem("audit", R.string.admin_nav_items_audit, "admin-sidebar-item-audit", listOf("audit:read")),
        AdminNavItem("analytics", R.string.admin_nav_items_analytics, "admin-sidebar-item-analytics", listOf("calls:read-history", "audit:read")),
        AdminNavItem("health", R.string.admin_nav_items_health, "admin-sidebar-item-health", listOf("settings:read")),
    )

    val platformItems = listOf(
        AdminNavItem("hubs", R.string.admin_nav_items_hubs, "admin-sidebar-item-hubs", listOf("system:manage-hubs"), "role-super-admin"),
        AdminNavItem("platform-roles", R.string.admin_nav_items_platform_roles, "admin-sidebar-item-platform-roles", listOf("system:manage-roles"), "role-super-admin"),
        AdminNavItem("platform-bans", R.string.admin_nav_items_platform_bans, "admin-sidebar-item-platform-bans", listOf("bans:read"), "role-super-admin"),
        AdminNavItem("platform-audit", R.string.admin_nav_items_platform_audit, "admin-sidebar-item-platform-audit", listOf("audit:read"), "role-super-admin"),
        AdminNavItem("platform-analytics", R.string.admin_nav_items_platform_analytics, "admin-sidebar-item-platform-analytics", listOf("calls:read-history", "audit:read"), "role-super-admin"),
        AdminNavItem("platform-health", R.string.admin_nav_items_platform_health, "admin-sidebar-item-platform-health", listOf("settings:read"), "role-super-admin"),
        AdminNavItem("platform-settings", R.string.admin_nav_items_platform_settings, "admin-sidebar-item-platform-settings", emptyList(), "role-super-admin"),
        AdminNavItem("gdpr-erasure", R.string.admin_nav_items_gdpr_erasure, "admin-sidebar-item-gdpr-erasure", listOf("settings:manage"), "role-super-admin"),
    )

    /** The nav item for [slug], or null for a section the sidebar does not list. */
    fun itemFor(slug: String): AdminNavItem? =
        thisHubItems.firstOrNull { it.slug == slug } ?: platformItems.firstOrNull { it.slug == slug }
}
