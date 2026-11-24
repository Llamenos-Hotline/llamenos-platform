// Resolves, to FILES, every dependency `connectedDebugAndroidTest` will need that
// `assembleDebug assembleDebugAndroidTest` does not (#2969).
//
//   bash scripts/ci/gradle-retry.sh -I ../../scripts/ci/gradle-resolve-connected-test.init.gradle.kts \
//     assembleDebug assembleDebugAndroidTest resolveConnectedTestDependencies
//
// WHY: AGP's Unified Test Platform keeps its own plugin classpath in internal
// configurations (`_internal-unified-test-platform-*`, e.g.
// `...-android-test-plugin-host-additional-test-output`). They are resolved only
// when `connectedDebugAndroidTest` itself starts, i.e. INSIDE the emulator, where a
// registry miss on `protobuf-java:4.28.3` failed a merge-queue group with no
// Cucumber scenario ever having run (#2969). Resolving them here, in a step that
// goes through gradle-retry.sh BEFORE the emulator boots, puts that dependency set
// under the same retry + --refresh-dependencies policy as every other one.
//
// A task, not a bare `./gradlew :app:dependencies`: that only resolves the graph
// (POMs), and the failure in #2969 was on the files.
//
// It fails when it matches NOTHING. AGP owns those configuration names; if a
// future AGP renames them this task must go red rather than quietly resolve
// nothing and leave the emulator run exposed again.
allprojects {
    plugins.withId("com.android.application") {
        tasks.register("resolveConnectedTestDependencies") {
            group = "verification"
            description = "Resolves the Unified Test Platform classpaths connectedDebugAndroidTest needs (#2969)."
            doLast {
                val platform = configurations.matching {
                    it.name.startsWith("_internal-unified-test-platform") && it.isCanBeResolved
                }
                check(platform.isNotEmpty()) {
                    "no `_internal-unified-test-platform*` configuration exists in ${project.path}: AGP renamed them, " +
                        "so this task no longer resolves what connectedDebugAndroidTest needs (#2969)"
                }
                platform.forEach { conf ->
                    logger.lifecycle("resolved ${conf.name}: ${conf.files.size} file(s)")
                }
            }
        }
    }
}
