package org.llamenos.hotline.ui.triage

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer

/**
 * Converting a triage report to a case (#1730). Android called
 * `POST /api/reports/:id/convert-to-case`, which the server has never mounted; the route is
 * `POST /api/records/convert-from-report`, whose body is `{ reportId, entityTypeId }` — both
 * UUIDs (`convertFromReportBodySchema`). The old client had no case type to send at all, so the
 * picker is fed from the hub's entity types.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TriageConvertRoutesTest {

    private val reportId = "11111111-1111-4111-8111-111111111111"
    private val caseTypeId = "22222222-2222-4222-8222-222222222222"
    private val archivedTypeId = "33333333-3333-4333-8333-333333333333"
    private val recordId = "44444444-4444-4444-8444-444444444444"
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes
    private val converted = mutableListOf<String>()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/reports") {
                json(
                    """{"conversations":[{"id":"$reportId","status":"waiting","createdAt":"2026-10-20T10:00:00.000Z",
                    |"metadata":{"type":"report","reportTitle":"Checkpoint"}}],"total":1}""".trimMargin(),
                )
            },
            Route("GET", "/api/settings/cms/report-types") { json("""{"reportTypes":[]}""") },
            Route("GET", "/api/hubs/:hubId/settings/cms/entity-types") {
                json(
                    """{"entityTypes":[
                    |{"id":"$caseTypeId","name":"arrest","label":"Arrest","isArchived":false},
                    |{"id":"$archivedTypeId","name":"old","label":"Old","isArchived":true}
                    |]}""".trimMargin(),
                )
            },
            Route("POST", "/api/hubs/:hubId/records/convert-from-report") { call ->
                val body = Json.parseToJsonElement(call.body).jsonObject
                val rid = body["reportId"]?.jsonPrimitive?.content
                val tid = body["entityTypeId"]?.jsonPrimitive?.content
                if (rid == null || tid == null || !uuid.matches(rid) || !uuid.matches(tid)) {
                    json("""{"error":"Validation failed"}""", 400)
                } else {
                    converted += rid
                    json(
                        """{"recordId":"$recordId","reportId":"$rid","entityTypeId":"$tid","caseNumber":"A-1",
                        |"autoAssigned":false,"assignedTo":[]}""".trimMargin(),
                        201,
                    )
                }
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    @Test
    fun `the picker offers the hub's live case types and not the archived ones`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = TriageViewModel(server.apiService, server.activeHubState)
            advanceUntilIdle()

            assertTrue(
                "expected GET /api/hubs/hub-a/settings/cms/entity-types, saw ${routes.seen()}",
                routes.seen().contains("GET /api/hubs/hub-a/settings/cms/entity-types"),
            )
            assertNull(vm.uiState.value.error)
            assertEquals(listOf(caseTypeId), vm.uiState.value.entityTypes.map { it.id })
        }

    @Test
    fun `converting posts the report and the chosen case type to the route the server mounts`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = TriageViewModel(server.apiService, server.activeHubState)
            advanceUntilIdle()
            val report = vm.uiState.value.reports.single()

            vm.convertToEntity(report, caseTypeId)
            advanceUntilIdle()

            assertTrue(
                "expected POST /api/hubs/hub-a/records/convert-from-report, saw ${routes.seen()}",
                routes.seen().contains("POST /api/hubs/hub-a/records/convert-from-report"),
            )
            assertTrue(
                "POST /reports/:id/convert-to-case is not mounted: ${routes.seen()}",
                routes.seen().none { it.endsWith("/convert-to-case") },
            )
            val sent = Json.parseToJsonElement(
                routes.bodiesSentTo("POST /api/hubs/hub-a/records/convert-from-report").single(),
            ).jsonObject
            assertEquals(reportId, sent.getValue("reportId").jsonPrimitive.content)
            assertEquals(caseTypeId, sent.getValue("entityTypeId").jsonPrimitive.content)
            assertNull(vm.uiState.value.error)
            // The server created the record and the screen holds the id it returned.
            assertEquals(listOf(reportId), converted)
            assertEquals(recordId, vm.uiState.value.lastConvertedRecordId)
        }
}
