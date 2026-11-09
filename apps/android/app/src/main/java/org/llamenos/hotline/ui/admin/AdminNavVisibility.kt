package org.llamenos.hotline.ui.admin

/**
 * Whether [granted] covers [required]: an exact match, a domain wildcard
 * (`calls:*` covers `calls:answer`), or the global wildcard `*`.
 *
 * Mirrors `permissionGranted` in `packages/shared/permissions.ts`, which is what the
 * server and the desktop client evaluate. Roles are permission bundles — a client
 * decides what to show from the permissions the server reports for the viewer
 * (`GET /api/auth/me`), never from a role id or name.
 */
fun permissionGranted(granted: Collection<String>, required: String): Boolean {
    if ("*" in granted) return true
    if (required in granted) return true
    val domain = required.substringBefore(':')
    return "$domain:*" in granted
}

/** A nav item is visible when the viewer holds ALL of its required permissions. */
fun AdminNavItem.isVisibleTo(granted: Collection<String>): Boolean =
    requiredPermissions.all { permissionGranted(granted, it) }

/** The items of [this] that the viewer holding [granted] may see, in order. */
fun List<AdminNavItem>.visibleTo(granted: Collection<String>): List<AdminNavItem> =
    filter { it.isVisibleTo(granted) }
