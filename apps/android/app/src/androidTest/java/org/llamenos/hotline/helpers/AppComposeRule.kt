package org.llamenos.hotline.helpers

import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import kotlinx.coroutines.test.StandardTestDispatcher

/**
 * The Compose test rule for any test that drives the real app (`MainActivity`).
 *
 * The rule replaces the app's Recomposer for every Activity launched under it, so its
 * effect context becomes the dispatcher of every `LaunchedEffect`, `collectAsState` and
 * `rememberCoroutineScope` coroutine in the app while the test runs.
 *
 * It must dispatch. `createEmptyComposeRule()`'s default is an `UnconfinedTestDispatcher`,
 * which resumes a coroutine on whichever thread resumed it: when `WebSocketService` sets
 * its connection `StateFlow` on a `Dispatchers.Default` worker, the composition's collector
 * — and, through `Snapshot.sendApplyNotifications()`, the Recomposer's own loop — runs on
 * that worker while the main thread is drawing. Compose's layout state is confined to the
 * main thread and production never breaks that (`AndroidUiDispatcher` posts every
 * resumption there); the unconfined harness does. A layout pass found already in progress
 * when the main thread draws — "performMeasureAndLayout called during measure layout" with
 * no measure frame on the main thread's stack (#2406) — is what a second thread inside the
 * same layout state looks like.
 *
 * A `StandardTestDispatcher` queues each resumption on the test scheduler, which the
 * Compose test clock runs only on the UI thread, matching production. Method tracing of the
 * PIN-confirm → dashboard transition shows Recomposer and snapshot-apply work on
 * `DefaultDispatcher` workers with the unconfined default, and on `main` only with this.
 */
fun createAppComposeRule(): ComposeTestRule =
    createEmptyComposeRule(effectContext = StandardTestDispatcher())
