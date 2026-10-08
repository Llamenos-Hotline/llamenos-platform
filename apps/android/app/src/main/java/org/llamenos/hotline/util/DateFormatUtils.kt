package org.llamenos.hotline.util

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Shared date/time formatting utilities for the app.
 *
 * All functions accept ISO 8601 date strings and format them using the
 * device locale for proper localization. Parsing failures silently fall
 * back to the raw input string.
 */
object DateFormatUtils {

    private val isoParser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private val isoParserWithZ = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    /**
     * Parse an ISO 8601 date string to a [Date], or null if unparseable.
     */
    private fun parseIso(isoDate: String): Date? {
        return try {
            if (isoDate.endsWith("Z")) {
                isoParserWithZ.parse(isoDate)
            } else {
                isoParser.parse(isoDate.substringBefore("+").substringBefore("["))
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Smart timestamp: shows time only if today, otherwise "MMM d, HH:mm".
     * Used for list items (calls, conversations, notes).
     */
    fun formatTimestamp(isoDate: String): String {
        val date = parseIso(isoDate) ?: return isoDate
        val now = Calendar.getInstance()
        val cal = Calendar.getInstance().apply { time = date }

        return if (now.get(Calendar.YEAR) == cal.get(Calendar.YEAR) &&
            now.get(Calendar.DAY_OF_YEAR) == cal.get(Calendar.DAY_OF_YEAR)
        ) {
            SimpleDateFormat("HH:mm", Locale.getDefault()).format(date)
        } else {
            SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(date)
        }
    }

    /**
     * Date only: "MMM d, yyyy". Used for contact first/last seen.
     */
    fun formatDate(isoDate: String): String {
        val date = parseIso(isoDate) ?: return isoDate
        return SimpleDateFormat("MMM d, yyyy", Locale.getDefault()).format(date)
    }

    /**
     * Verbose date: "MMMM d, yyyy 'at' HH:mm". Used for note detail view.
     */
    fun formatDateVerbose(isoDate: String): String {
        val date = parseIso(isoDate) ?: return isoDate
        return SimpleDateFormat("MMMM d, yyyy 'at' HH:mm", Locale.getDefault()).format(date)
    }

    /**
     * Time only: "HH:mm". Used for dashboard active shift timer.
     */
    fun formatTimeOnly(isoDate: String): String {
        val date = parseIso(isoDate) ?: return isoDate
        return SimpleDateFormat("HH:mm", Locale.getDefault()).format(date)
    }

    /**
     * Locale-aware short day-of-week names (Sun=0..Sat=6).
     * Lazily initialized per locale.
     */
    fun shortDayName(dayIndex: Int): String {
        val cal = Calendar.getInstance().apply {
            set(Calendar.DAY_OF_WEEK, Calendar.SUNDAY + dayIndex)
        }
        return SimpleDateFormat("EEE", Locale.getDefault()).format(cal.time)
    }

    /**
     * Format call duration in seconds to a human-readable string.
     * Examples: "45s", "5m 30s", "1h 15m".
     */
    fun formatDuration(seconds: Int): String {
        val hours = seconds / 3600
        val minutes = (seconds % 3600) / 60
        val secs = seconds % 60
        return when {
            hours > 0 -> "${hours}h ${minutes}m"
            minutes > 0 -> "${minutes}m ${secs}s"
            else -> "${secs}s"
        }
    }
}
