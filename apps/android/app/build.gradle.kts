import java.security.MessageDigest
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
    alias(libs.plugins.roborazzi)
}

// ecryptfs (encrypted home dirs) has a 143-byte filename limit. D8 global synthetics
// for Compose lambdas generate filenames up to ~150 chars, causing build failures.
// So on Linux the build output must live outside the (possibly ecryptfs) checkout.
//
// It must NOT live in one fixed shared directory, though: three self-hosted CI runners
// share a single box, and this repo is routinely built from several git worktrees at
// once. Concurrent builds then delete each other's intermediates mid-run — see the
// `mergeDebugResources` / `kspDebugKotlin` "No such file or directory" failures on
// PRs #645 and #651. Scope the directory per checkout, and per CI job where possible.
//
// Resolution order:
//   1. ANDROID_BUILD_DIR — explicit override (CI pins this per job).
//   2. $RUNNER_TEMP      — GitHub Actions gives each concurrent job its own. On this
//                          fleet it resolves to /opt/runner-llamenos-N/_work/_temp,
//                          i.e. not under an encrypted home, so the limit above is moot.
//   3. /tmp              — the known-good non-ecryptfs location the original fix used.
// In cases 2 and 3 a short digest of this checkout's absolute path keeps worktrees and
// runners apart. The digest is stable per checkout, so incremental builds still hit.
val explicitBuildDir = System.getenv("ANDROID_BUILD_DIR")
if (explicitBuildDir != null) {
    layout.buildDirectory = file(explicitBuildDir)
} else if (System.getProperty("os.name")?.lowercase()?.contains("linux") == true) {
    val base = System.getenv("RUNNER_TEMP")?.takeIf { it.isNotEmpty() } ?: "/tmp"
    val checkoutId = MessageDigest.getInstance("SHA-256")
        .digest(rootProject.projectDir.absolutePath.toByteArray())
        .take(4)
        .joinToString("") { "%02x".format(it) }
    layout.buildDirectory = file("$base/llamenos-android-build-$checkoutId/app")
}

android {
    namespace = "org.llamenos.hotline"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.llamenos.hotline"
        testApplicationId = "org.llamenos.hotline"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.19.18"

        testInstrumentationRunner = "org.llamenos.hotline.CucumberHiltRunner"

        // AGP 9.x no longer auto-forwards -Pandroid.testInstrumentationRunnerArguments.*
        // properties to the instrumentation runner. Explicitly forward them here so that
        // CI shard filtering (cucumberFeatures), backend URL (testHubUrl), and reset
        // secret (testSecret) reach CucumberHiltRunner.onCreate().
        val prefix = "android.testInstrumentationRunnerArguments."
        project.properties.forEach { (key, value) ->
            if (key.startsWith(prefix) && value is String) {
                testInstrumentationRunnerArguments[key.removePrefix(prefix)] = value
            }
        }
    }

    // Signing credentials resolution order:
    //   1. keystore.properties file (local dev — gitignored)
    //   2. Environment variables (CI/CD)
    // keystore.properties lives at apps/android/keystore.properties (see keystore.properties.example)
    val keystoreProps = Properties().also { props ->
        rootProject.file("keystore.properties").takeIf { it.exists() }?.reader()?.use { props.load(it) }
    }
    fun signingProp(propKey: String, envKey: String, default: String = "") =
        keystoreProps.getProperty(propKey)?.takeIf { it.isNotEmpty() }
            ?: System.getenv(envKey)?.takeIf { it.isNotEmpty() }
            ?: default

    signingConfigs {
        create("release") {
            storeFile = file(signingProp("storeFile", "KEYSTORE_PATH", "../upload-keystore.jks"))
            storePassword = signingProp("storePassword", "KEYSTORE_PASSWORD")
            keyAlias = signingProp("keyAlias", "KEY_ALIAS", "upload")
            keyPassword = signingProp("keyPassword", "KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Apply release signing when credentials are available (local keystore.properties or CI env vars).
            // Falls back to debug signing for unsigned local builds.
            val hasCredentials = signingProp("storePassword", "KEYSTORE_PASSWORD").isNotEmpty()
            if (hasCredentials) {
                signingConfig = signingConfigs.getByName("release")
            }
            ndk {
                abiFilters += listOf("armeabi-v7a", "arm64-v8a")
            }
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            ndk {
                abiFilters += listOf("x86_64")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            // Include generated protocol types from codegen
            kotlin.srcDir("${rootProject.projectDir}/../../packages/protocol/generated/kotlin")
        }
        // JNI .so files are in build-type source sets:
        //   src/debug/jniLibs/   — test-kdf params (x86_64 emulator)
        //   src/release/jniLibs/ — production params (arm64-v8a + armeabi-v7a)
        // Gradle discovers these automatically — no explicit config needed.
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        // Translations are generated by i18n codegen from packages/i18n/locales/.
        // New strings are added to en.json first; other locales catch up asynchronously.
        // Treat missing translations as warnings, not errors, until all locales are complete.
        warning += "MissingTranslation"
    }

    testOptions {
        unitTests {
            // isReturnDefaultValues lets JVM unit tests call Android framework methods
            // (e.g. android.util.Log) without throwing UnsupportedOperationException.
            // Trade-off: framework calls that should be mocked will silently return
            // 0/false/null instead of failing loudly. Long-term fix: wrap Log behind
            // an abstraction. For now, this is the standard Android approach.
            isReturnDefaultValues = true
            // Required for Robolectric to access Android resources (strings, drawables, etc.)
            isIncludeAndroidResources = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

// Copy shared test vectors from packages/crypto for E2E crypto interop tests
val copyTestVectors by tasks.registering(Copy::class) {
    from("${rootProject.projectDir}/../../packages/crypto/tests/fixtures/test-vectors.json")
    into("src/androidTest/assets")
}

// Copy BDD feature files from shared test-specs for Cucumber test runner.
// Only include platform/mobile/ features — core/, security/, admin/, and
// platform/desktop/ features have steps not implemented on Android and
// cause UndefinedStepException crashes even when filtered by @android tag
// (backend+android dual-tagged features still load backend-only steps).
val copyFeatureFiles by tasks.registering(Copy::class) {
    from("${rootProject.projectDir}/../../packages/test-specs/features/platform/mobile")
    into("src/androidTest/assets/features/platform/mobile")
}

tasks.named("preBuild") {
    dependsOn(copyTestVectors)
    dependsOn(copyFeatureFiles)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.navigation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel)
    implementation(libs.core.ktx)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation)

    implementation(libs.okhttp)
    implementation(libs.coroutines.android)
    implementation(libs.coroutines.core)
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.datastore.preferences)
    implementation(libs.play.services.location)
    implementation(libs.security.crypto)
    implementation(libs.androidx.biometric)

    implementation(libs.unifiedpush) {
        // UnifiedPush v3 depends on com.google.crypto.tink:tink which conflicts
        // with tink-android pulled by security-crypto. Exclude the JVM variant;
        // tink-android satisfies the same API on Android.
        exclude(group = "com.google.crypto.tink", module = "tink")
    }

    // CameraX for QR code scanning (device linking)
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)

    // ML Kit for barcode/QR detection
    implementation(libs.mlkit.barcode)

    // JNA for UniFFI-generated Rust bindings (llamenos-core)
    implementation(libs.jna) { artifact { type = "aar" } }

    // Linphone SDK for SIP/VoIP (multi-hub parallel ringing)
    implementation("org.linphone:linphone-sdk-android:5.4.100")

    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.turbine)
    testImplementation(libs.mockk)
    testImplementation(kotlin("test"))
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.robolectric)

    androidTestImplementation(libs.espresso)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.ext.junit)
    androidTestImplementation(libs.cucumber.android)
    androidTestImplementation(kotlin("test"))
}
