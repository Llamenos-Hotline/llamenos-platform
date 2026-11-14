package org.llamenos.hotline.ui.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.screenshots.ScreenshotTestApp
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #2540: the five admin deletes — remove a hub ban, remove a platform ban, delete a shift,
 * delete a custom field, archive a report category — must be impossible on one tap.
 *
 * Each test drives the real tab against a real [AdminViewModel] and a real
 * [org.llamenos.hotline.api.ApiService] over a stateful fake server, and asserts on **what the
 * server still holds**, not on a callback firing. Both halves are asserted for every action:
 * a tap alone leaves the record in place, and confirming still removes it. Without the second
 * half "nothing happens" would pass for a button that is simply broken.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ScreenshotTestApp::class, qualifiers = "w411dp-h891dp-xxhdpi")
class AdminDeletionConfirmationTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    private val bans = mutableListOf<JsonObject>()
    private val platformBans = mutableListOf<JsonObject>()
    private val shifts = mutableListOf<JsonObject>()
    private val reportTypes = mutableListOf<JsonObject>()
    private var fields: JsonArray = JsonArray(emptyList())

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun hash(seed: Int) = "%064x".format(seed)

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/bans") { json("""{"bans":${JsonArray(bans)}}""") },
            Route("DELETE", "/api/hubs/:hubId/bans/:phoneHash") { call ->
                bans.removeAll { it.getValue("phoneHash").jsonPrimitive.content == call.params["phoneHash"] }
                json("""{"ok":true}""")
            },
            Route("GET", "/api/admin/bans") {
                json("""{"bans":${JsonArray(platformBans)},"total":${platformBans.size}}""")
            },
            Route("DELETE", "/api/admin/bans/:id") { call ->
                platformBans.removeAll { it.getValue("phoneHash").jsonPrimitive.content == call.params["id"] }
                json("""{"ok":true}""")
            },
            Route("GET", "/api/hubs/:hubId/shifts") { json("""{"shifts":${JsonArray(shifts)}}""") },
            Route("DELETE", "/api/hubs/:hubId/shifts/:id") { call ->
                shifts.removeAll { it.getValue("id").jsonPrimitive.content == call.params["id"] }
                json("""{"ok":true}""")
            },
            Route("GET", "/api/settings/custom-fields") { json("""{"fields":$fields}""") },
            Route("PUT", "/api/settings/custom-fields") { call ->
                fields = Json.parseToJsonElement(call.body).jsonObject.getValue("fields").jsonArray
                json("""{"fields":$fields}""")
            },
            Route("GET", "/api/settings/report-types") { json("""{"reportTypes":${JsonArray(reportTypes)}}""") },
            Route("DELETE", "/api/settings/report-types/:id") { call ->
                // The server archives, it never removes the row: existing reports keep their type.
                val i = reportTypes.indexOfFirst { it.getValue("id").jsonPrimitive.content == call.params["id"] }
                reportTypes[i] = JsonObject(reportTypes[i] + ("isArchived" to Json.parseToJsonElement("true")))
                json("""{"ok":true}""")
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun viewModel() = AdminViewModel(server.apiService, SavedStateHandle())

    private fun deletesSent() = routes.seen().filter { it.startsWith("DELETE ") || it.startsWith("PUT ") }

    // ── hub ban ──────────────────────────────────────────────────────────────

    private fun seedBan(): String {
        val h = hash(1)
        bans += obj("""{"phoneHash":"$h","reason":"harassing calls","bannedBy":"${"aa".repeat(32)}","bannedAt":"2026-10-20T10:00:00.000Z"}""")
        return h
    }

    @Test
    fun `one tap on remove ban leaves the ban in force and asks first`() {
        val h = seedBan()
        val vm = viewModel().also { it.loadBans() }
        composeRule.setContent { LlamenosTheme { BanListTab(viewModel = vm) } }

        composeRule.onNodeWithTag("remove-ban-$h").performClick()

        composeRule.onNodeWithTag("remove-ban-dialog").assertIsDisplayed()
        assertEquals("the ban must still be in force", 1, bans.size)
        assertTrue("nothing may be sent yet: ${routes.seen()}", deletesSent().isEmpty())
    }

    @Test
    fun `cancelling the remove ban dialog keeps the ban`() {
        val h = seedBan()
        val vm = viewModel().also { it.loadBans() }
        composeRule.setContent { LlamenosTheme { BanListTab(viewModel = vm) } }

        composeRule.onNodeWithTag("remove-ban-$h").performClick()
        composeRule.onNodeWithTag("cancel-remove-ban-button").performClick()

        composeRule.onNodeWithTag("remove-ban-dialog").assertDoesNotExist()
        assertEquals(1, bans.size)
        assertTrue(deletesSent().isEmpty())
    }

    @Test
    fun `confirming the remove ban dialog unbans by the row's phoneHash`() {
        val h = seedBan()
        val vm = viewModel().also { it.loadBans() }
        composeRule.setContent { LlamenosTheme { BanListTab(viewModel = vm) } }

        composeRule.onNodeWithTag("remove-ban-$h").performClick()
        composeRule.onNodeWithTag("confirm-remove-ban-button").performClick()

        assertTrue("expected DELETE of the ban, saw ${routes.seen()}", routes.seen().contains("DELETE /api/hubs/hub-a/bans/$h"))
        assertTrue("the server must no longer hold the ban", bans.isEmpty())
        assertTrue("the reloaded list must be empty", vm.uiState.value.bans.isEmpty())
    }

    // ── platform ban ─────────────────────────────────────────────────────────

    private fun seedPlatformBan(): String {
        val h = hash(2)
        platformBans += obj("""{"id":"$h","phoneHash":"$h","reason":"coordinated abuse","bannedBy":"${"aa".repeat(32)}","bannedAt":"2026-10-20T10:00:00.000Z"}""")
        return h
    }

    @Test
    fun `one tap on remove platform ban leaves the ban in force and asks first`() {
        val h = seedPlatformBan()
        val vm = viewModel().also { it.loadPlatformBans() }
        composeRule.setContent { LlamenosTheme { PlatformBansTab(viewModel = vm) } }

        composeRule.onNodeWithTag("remove-platform-ban-$h").performClick()

        composeRule.onNodeWithTag("remove-platform-ban-dialog").assertIsDisplayed()
        assertEquals(1, platformBans.size)
        assertTrue("nothing may be sent yet: ${routes.seen()}", deletesSent().isEmpty())
    }

    @Test
    fun `cancelling the remove platform ban dialog keeps the ban`() {
        val h = seedPlatformBan()
        val vm = viewModel().also { it.loadPlatformBans() }
        composeRule.setContent { LlamenosTheme { PlatformBansTab(viewModel = vm) } }

        composeRule.onNodeWithTag("remove-platform-ban-$h").performClick()
        composeRule.onNodeWithTag("cancel-remove-platform-ban-button").performClick()

        composeRule.onNodeWithTag("remove-platform-ban-dialog").assertDoesNotExist()
        assertEquals(1, platformBans.size)
        assertTrue(deletesSent().isEmpty())
    }

    @Test
    fun `confirming the remove platform ban dialog removes the ban`() {
        val h = seedPlatformBan()
        val vm = viewModel().also { it.loadPlatformBans() }
        composeRule.setContent { LlamenosTheme { PlatformBansTab(viewModel = vm) } }

        composeRule.onNodeWithTag("remove-platform-ban-$h").performClick()
        composeRule.onNodeWithTag("confirm-remove-platform-ban-button").performClick()

        assertTrue("expected DELETE of the platform ban, saw ${routes.seen()}", routes.seen().contains("DELETE /api/admin/bans/$h"))
        assertTrue(platformBans.isEmpty())
    }

    // ── shift ────────────────────────────────────────────────────────────────

    private fun seedShift(): String {
        shifts += obj("""{"id":"shift-1","encryptedName":"Overnight","startTime":"22:00","endTime":"06:00","days":[0,1,2,3,4,5,6],"userPubkeys":["${"bb".repeat(32)}"],"createdAt":"2026-10-20T10:00:00.000Z"}""")
        return "shift-1"
    }

    @Test
    fun `one tap on delete shift leaves the shift in place and asks first`() {
        val id = seedShift()
        val vm = viewModel().also { it.loadAdminShifts() }
        composeRule.setContent { LlamenosTheme { ShiftScheduleTab(viewModel = vm) } }

        composeRule.onNodeWithTag("delete-shift-$id").performClick()

        composeRule.onNodeWithTag("delete-shift-dialog").assertIsDisplayed()
        assertEquals(1, shifts.size)
        assertTrue("nothing may be sent yet: ${routes.seen()}", deletesSent().isEmpty())
    }

    @Test
    fun `cancelling the delete shift dialog keeps the shift`() {
        val id = seedShift()
        val vm = viewModel().also { it.loadAdminShifts() }
        composeRule.setContent { LlamenosTheme { ShiftScheduleTab(viewModel = vm) } }

        composeRule.onNodeWithTag("delete-shift-$id").performClick()
        composeRule.onNodeWithTag("cancel-delete-shift-button").performClick()

        composeRule.onNodeWithTag("delete-shift-dialog").assertDoesNotExist()
        assertEquals(1, shifts.size)
        assertTrue(deletesSent().isEmpty())
    }

    @Test
    fun `confirming the delete shift dialog deletes the shift`() {
        val id = seedShift()
        val vm = viewModel().also { it.loadAdminShifts() }
        composeRule.setContent { LlamenosTheme { ShiftScheduleTab(viewModel = vm) } }

        composeRule.onNodeWithTag("delete-shift-$id").performClick()
        composeRule.onNodeWithTag("confirm-delete-shift-button").performClick()

        assertTrue("expected DELETE of the shift, saw ${routes.seen()}", routes.seen().contains("DELETE /api/hubs/hub-a/shifts/$id"))
        assertTrue(shifts.isEmpty())
    }

    // ── custom field ─────────────────────────────────────────────────────────

    private fun seedFields() {
        fields = Json.parseToJsonElement(
            """[{"id":"f1","name":"age","label":"Age","type":"text","required":false,"visibleToUsers":true,
            |"editableByUsers":true,"context":"all","order":0,"createdAt":"2026-10-20T10:00:00.000Z"},
            |{"id":"f2","name":"city","label":"City","type":"text","required":false,"visibleToUsers":true,
            |"editableByUsers":true,"context":"all","order":1,"createdAt":"2026-10-20T10:00:00.000Z"}]""".trimMargin(),
        ).jsonArray
    }

    private fun fieldNames() = fields.map { it.jsonObject.getValue("name").jsonPrimitive.content }

    @Test
    fun `one tap on delete field leaves the field definition in place and asks first`() {
        seedFields()
        val vm = viewModel().also { it.loadCustomFields() }
        composeRule.setContent { LlamenosTheme { CustomFieldsTab(viewModel = vm) } }

        composeRule.onNodeWithTag("delete-field-f1").performClick()

        composeRule.onNodeWithTag("delete-field-dialog").assertIsDisplayed()
        assertEquals(listOf("age", "city"), fieldNames())
        assertTrue("nothing may be sent yet: ${routes.seen()}", deletesSent().isEmpty())
    }

    @Test
    fun `cancelling the delete field dialog keeps the field`() {
        seedFields()
        val vm = viewModel().also { it.loadCustomFields() }
        composeRule.setContent { LlamenosTheme { CustomFieldsTab(viewModel = vm) } }

        composeRule.onNodeWithTag("delete-field-f1").performClick()
        composeRule.onNodeWithTag("cancel-delete-field-button").performClick()

        composeRule.onNodeWithTag("delete-field-dialog").assertDoesNotExist()
        assertEquals(listOf("age", "city"), fieldNames())
        assertTrue(deletesSent().isEmpty())
    }

    @Test
    fun `confirming the delete field dialog saves the shorter list`() {
        seedFields()
        val vm = viewModel().also { it.loadCustomFields() }
        composeRule.setContent { LlamenosTheme { CustomFieldsTab(viewModel = vm) } }

        composeRule.onNodeWithTag("delete-field-f1").performClick()
        composeRule.onNodeWithTag("confirm-delete-field-button").performClick()

        assertEquals(listOf("city"), fieldNames())
        assertEquals(listOf("city"), vm.uiState.value.customFields.map { it.name })
        assertTrue(
            "the 404 admin prefix must not be touched: ${routes.seen()}",
            routes.seen().none { it.contains("/api/admin/") },
        )
    }

    // ── report category ──────────────────────────────────────────────────────

    private fun seedReportTypes() {
        reportTypes += obj("""{"id":"rt-1","name":"Incident","isArchived":false,"createdAt":"2026-10-20T10:00:00.000Z"}""")
        reportTypes += obj("""{"id":"rt-2","name":"Follow-up","isArchived":false,"createdAt":"2026-10-20T10:00:00.000Z"}""")
    }

    private fun archivedIds() =
        reportTypes.filter { it["isArchived"]?.jsonPrimitive?.content == "true" }.map { it.getValue("id").jsonPrimitive.content }

    private fun setReportCategories(vm: AdminViewModel) = composeRule.setContent {
        LlamenosTheme { AdminSectionHost(viewModel = vm) }
    }

    @Test
    fun `one tap on delete category leaves the category in place and asks first`() {
        seedReportTypes()
        val vm = AdminViewModel(server.apiService, SavedStateHandle(mapOf(AdminViewModel.SECTION_ARG to "report-types")))
        setReportCategories(vm)

        composeRule.onNodeWithTag("delete-category-rt-1").performClick()

        composeRule.onNodeWithTag("delete-category-dialog").assertIsDisplayed()
        assertTrue("nothing may be archived yet", archivedIds().isEmpty())
        assertTrue("nothing may be sent yet: ${routes.seen()}", deletesSent().isEmpty())
    }

    @Test
    fun `cancelling the delete category dialog keeps the category`() {
        seedReportTypes()
        val vm = AdminViewModel(server.apiService, SavedStateHandle(mapOf(AdminViewModel.SECTION_ARG to "report-types")))
        setReportCategories(vm)

        composeRule.onNodeWithTag("delete-category-rt-1").performClick()
        composeRule.onNodeWithTag("cancel-delete-category-button").performClick()

        composeRule.onNodeWithTag("delete-category-dialog").assertDoesNotExist()
        assertTrue(archivedIds().isEmpty())
        assertTrue(deletesSent().isEmpty())
    }

    @Test
    fun `confirming the delete category dialog archives it and the list drops it`() {
        seedReportTypes()
        val vm = AdminViewModel(server.apiService, SavedStateHandle(mapOf(AdminViewModel.SECTION_ARG to "report-types")))
        setReportCategories(vm)

        composeRule.onNodeWithTag("delete-category-rt-1").performClick()
        composeRule.onNodeWithTag("confirm-delete-category-button").performClick()

        assertEquals(listOf("rt-1"), archivedIds())
        assertEquals(listOf("rt-2"), vm.uiState.value.reportCategories.map { it.id })
    }

    // ── a confirmation is for one action on one row ──────────────────────────

    /** Press the destructive button of a real dialog and keep the token it minted. */
    private fun mintConfirmation(action: AdminDeletion, targetId: String): DeletionConfirmed {
        var minted: DeletionConfirmed? = null
        composeRule.setContent {
            LlamenosTheme {
                DeletionConfirmed.Dialog(
                    action = action,
                    targetId = targetId,
                    subject = "",
                    onConfirmed = { minted = it },
                    onDismiss = {},
                )
            }
        }
        composeRule.onNodeWithTag(action.confirmTag).performClick()
        return checkNotNull(minted) { "pressing the destructive button must mint a confirmation" }
    }

    @Test
    fun `a confirmation for one action cannot authorise another`() {
        val h = seedBan()
        val vm = viewModel().also { it.loadBans() }
        val shiftConfirmation = mintConfirmation(AdminDeletion.SHIFT, h)

        val refused = runCatching { vm.removeBan(h, shiftConfirmation) }.exceptionOrNull()

        assertTrue("a shift confirmation must not remove a ban, got $refused", refused is IllegalArgumentException)
        assertEquals("the ban must still be in force", 1, bans.size)
        assertTrue(deletesSent().isEmpty())
    }

    @Test
    fun `a confirmation for one row cannot authorise deleting another`() {
        val h = seedBan()
        val other = hash(99)
        val vm = viewModel().also { it.loadBans() }
        val confirmationForOther = mintConfirmation(AdminDeletion.BAN, other)

        val refused = runCatching { vm.removeBan(h, confirmationForOther) }.exceptionOrNull()

        assertTrue("a confirmation of another row must be refused, got $refused", refused is IllegalArgumentException)
        assertEquals(1, bans.size)
        assertTrue(deletesSent().isEmpty())
    }
}
