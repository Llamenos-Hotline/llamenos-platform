package org.llamenos.hotline.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The admin sidebar shows a section only when the viewer's permissions cover it (#2574).
 * Roles are permission bundles: nothing here, in the code under test, or in
 * [AdminNavConfig] may mention a role id or name.
 */
class AdminNavVisibilityTest {

    private fun slugs(items: List<AdminNavItem>) = items.map { it.slug }

    @Test
    fun `permissionGranted matches exact, domain wildcard and global wildcard like the shared helper`() {
        assertTrue(permissionGranted(listOf("bans:read"), "bans:read"))
        assertFalse(permissionGranted(listOf("bans:read"), "bans:create"))
        assertTrue(permissionGranted(listOf("calls:*"), "calls:answer"))
        assertFalse(permissionGranted(listOf("calls:*"), "bans:read"))
        assertTrue(permissionGranted(listOf("*"), "system:manage-hubs"))
        assertFalse(permissionGranted(emptyList(), "settings:read"))
    }

    @Test
    fun `a viewer with no permissions sees no section at all`() {
        assertEquals(emptyList<String>(), slugs(AdminNavConfig.thisHubItems.visibleTo(emptyList())))
        assertEquals(emptyList<String>(), slugs(AdminNavConfig.platformItems.visibleTo(emptyList())))
    }

    @Test
    fun `every section is gated, so an empty permission set can never show one`() {
        val ungated = (AdminNavConfig.thisHubItems + AdminNavConfig.platformItems)
            .filter { it.requiredPermissions.isEmpty() }
        assertEquals(emptyList<String>(), slugs(ungated))
    }

    @Test
    fun `the global wildcard sees every section`() {
        assertEquals(
            slugs(AdminNavConfig.thisHubItems),
            slugs(AdminNavConfig.thisHubItems.visibleTo(listOf("*"))),
        )
        assertEquals(
            slugs(AdminNavConfig.platformItems),
            slugs(AdminNavConfig.platformItems.visibleTo(listOf("*"))),
        )
    }

    @Test
    fun `hub-level permissions do not unlock platform sections`() {
        // A hub admin holds hub-scoped permissions such as these. Platform sections
        // need system:* permissions; before #2574 the only thing keeping a hub admin
        // out was a role id that nothing ever evaluated.
        val hubAdmin = listOf("settings:read", "settings:manage", "bans:read", "audit:read", "calls:read-history")
        assertEquals(emptyList<String>(), slugs(AdminNavConfig.platformItems.visibleTo(hubAdmin)))
        assertTrue("bans" in slugs(AdminNavConfig.thisHubItems.visibleTo(hubAdmin)))
    }

    @Test
    fun `a permission-bundle role reveals exactly the sections its permissions cover`() {
        val auditor = listOf("system:view-audit", "system:view-bans")
        assertEquals(
            listOf("platform-bans", "platform-audit"),
            slugs(AdminNavConfig.platformItems.visibleTo(auditor)),
        )
    }

    @Test
    fun `a multi-permission section needs all of its permissions`() {
        val analytics = AdminNavConfig.thisHubItems.single { it.slug == "analytics" }
        assertFalse(analytics.isVisibleTo(listOf("audit:read")))
        assertFalse(analytics.isVisibleTo(listOf("calls:read-history")))
        assertTrue(analytics.isVisibleTo(listOf("audit:read", "calls:read-history")))
    }

    @Test
    fun `slugs are unique across the hub and platform sections`() {
        val all = slugs(AdminNavConfig.thisHubItems + AdminNavConfig.platformItems)
        assertEquals(all.size, all.toSet().size)
    }
}
