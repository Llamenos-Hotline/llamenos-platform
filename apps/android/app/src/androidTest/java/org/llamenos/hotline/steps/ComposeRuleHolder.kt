package org.llamenos.hotline.steps

import io.cucumber.junit.WithJunitRule
import org.junit.Rule
import org.llamenos.hotline.helpers.createAppComposeRule

/**
 * Holds the Compose test rule and activity scenario for Cucumber step definitions.
 *
 * Annotated with [@WithJunitRule] so Cucumber creates it eagerly and processes
 * the JUnit [@Rule]. Step definition classes access this via [current].
 *
 * [activityScenarioHolder] lives here (not as a separate Cucumber class) to
 * ensure it's initialized before any step methods run.
 */
@WithJunitRule(useAsTestClassInDescription = true)
class ComposeRuleHolder {

    /** See [createAppComposeRule] for why this rule must dispatch on the UI thread (#2406). */
    @get:Rule(order = 0)
    val composeRule = createAppComposeRule()

    val activityScenarioHolder = ActivityScenarioHolder()

    init {
        current = this
    }

    companion object {
        @Volatile
        lateinit var current: ComposeRuleHolder
            private set
    }
}
