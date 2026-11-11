package org.llamenos.hotline.crypto

import android.util.Log

/**
 * Thrown when a crypto operation needs the Rust JNI library (`libllamenos_core.so`) and the
 * build does not contain it.
 *
 * This is a build/packaging fault, not a user error, and it must never read as one. Callers
 * that translate failures into user-facing messages (PIN entry, onboarding) have to let this
 * type through unchanged: folding it into "Incorrect PIN" sends whoever is debugging hunting
 * for an onboarding bug that does not exist, and burns real PIN attempts toward a key wipe
 * (#1278).
 *
 * Extends [IllegalStateException] so the existing hard-fail contract (`check(...)` semantics)
 * is unchanged; [cause] is the original [UnsatisfiedLinkError] from `System.loadLibrary`.
 */
class NativeCryptoLibraryMissingException(message: String, cause: Throwable?) :
    IllegalStateException(message, cause)

/**
 * Single owner of loading `llamenos_core`, shared by [CryptoService] and [WakeKeyService].
 *
 * The library is loaded once per process. A failure is *kept*, not swallowed: it is logged at
 * ERROR when it happens and re-surfaced, with the original [UnsatisfiedLinkError] as the cause
 * and the fix in the message, by every [require] call. There is deliberately no fallback to
 * placeholder crypto — without the native library every crypto operation hard-fails.
 */
internal object NativeCryptoLibrary {
    private const val TAG = "NativeCryptoLibrary"
    private const val LIBRARY_NAME = "llamenos_core"

    private val loadFailure: UnsatisfiedLinkError? = try {
        System.loadLibrary(LIBRARY_NAME)
        null
    } catch (e: UnsatisfiedLinkError) {
        Log.e(TAG, missingMessage(e), e)
        e
    }

    val isLoaded: Boolean get() = loadFailure == null

    /** Returns normally when the library is loaded; otherwise throws [NativeCryptoLibraryMissingException]. */
    fun require() {
        val failure = loadFailure ?: return
        throw NativeCryptoLibraryMissingException(missingMessage(failure), failure)
    }

    internal fun missingMessage(cause: UnsatisfiedLinkError): String =
        "Native crypto library '$LIBRARY_NAME' is not loaded — the Rust JNI libs are missing from " +
            "this build (${cause.message}). Build them with " +
            "`packages/crypto/scripts/build-mobile.sh android` and copy " +
            "dist/android/jniLibs-{debug,release}/ into apps/android/app/src/{debug,release}/jniLibs/ " +
            "(see apps/android/README.md). There is no placeholder-crypto fallback."
}
