package org.llamenos.hotline

import android.util.Log
import io.cucumber.android.runner.CucumberAndroidJUnitRunner
import io.cucumber.junit.CucumberOptions

/**
 * Cucumber test runner for BDD E2E tests.
 *
 * Reads .feature files from androidTest/assets/features/ and matches them
 * with step definitions in the [org.llamenos.hotline.steps] package.
 *
 * Feature files are copied from packages/test-specs/features/ by the Gradle
 * copyFeatureFiles task at preBuild time.
 *
 * Uses the production [LlamenosApp] (via manifest) so the real Hilt component
 * is available for @AndroidEntryPoint activities. No HiltTestApplication needed
 * since we don't replace any bindings in E2E tests.
 */
@CucumberOptions(
    features = ["features"],
    glue = ["org.llamenos.hotline.steps"],
    tags = "@android and not @wip",
)
class CucumberHiltRunner : CucumberAndroidJUnitRunner() {

    override fun onCreate(arguments: android.os.Bundle) {
        // Override compile-time @CucumberOptions features with runtime instrumentation arg.
        //
        // Two paths set the shard feature list:
        // 1. CI (Gradle -P): uses "cucumberFeatures" (no dot) because Gradle's
        //    -Pandroid.testInstrumentationRunnerArguments.cucumber.features silently
        //    drops the value — dots in the key get misinterpreted as nested property access.
        // 2. Local (am instrument -e): uses "cucumber.features" directly — dots are
        //    fine in bundle keys set via `am instrument`.
        //
        // We check both keys and write to "cucumber.features" which is what
        // cucumber-android's CucumberAndroidJUnitRunner reads from the bundle.
        val shardFeatures = arguments.getString("cucumberFeatures")
            ?: arguments.getString("cucumber.features")
        if (!shardFeatures.isNullOrBlank()) {
            arguments.putString("cucumber.features", shardFeatures)
        }
        super.onCreate(arguments)
    }

    override fun onStart() {
        logAllThreadStacksOnCrash()
        super.onStart()
    }

    /**
     * The app and the test code share this process, so an app crash kills the whole
     * instrumentation run and logcat names only the thread that threw. That is not enough
     * for Compose's "performMeasureAndLayout called during measure layout" (#1825): the
     * throwing main thread is merely the *second* party, and the thread that was inside a
     * layout pass at the time is exactly the one the trace omits. Log every thread's stack
     * at the moment of the crash so the next occurrence names it.
     */
    private fun logAllThreadStacksOnCrash() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { crashed, error ->
            runCatching {
                Log.e(CRASH_TAG, "Uncaught ${error::class.java.name} on '${crashed.name}': ${error.message}")
                for ((thread, frames) in Thread.getAllStackTraces()) {
                    if (thread === crashed) continue
                    Log.e(CRASH_TAG, "--- '${thread.name}' (${thread.state}) ---\n" + frames.joinToString("\n") { "    at $it" })
                }
            }
            previous?.uncaughtException(crashed, error)
        }
    }

    private companion object {
        const val CRASH_TAG = "CrashThreadDump"
    }
}
