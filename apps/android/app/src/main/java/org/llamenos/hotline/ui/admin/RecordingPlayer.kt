package org.llamenos.hotline.ui.admin

import android.media.MediaDataSource
import android.media.MediaPlayer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FastForward
import androidx.compose.material.icons.filled.FastRewind
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiException

/**
 * Audio playback composable for call recordings.
 *
 * The audio is fetched through [loadAudio] — an authenticated API request — and played
 * from memory via [ByteArrayMediaDataSource]. It is never handed to [MediaPlayer] as a
 * URL: the recording route requires a signed request, which a media player cannot make,
 * and the audio is never written to disk. Provides play/pause, seek forward/back 15s,
 * progress indicator, and time display.
 *
 * @param callId The call whose recording to play; a new id reloads the player
 * @param loadAudio Fetches the recording bytes for [callId] (`GET /calls/:callId/recording`)
 */
@Composable
fun RecordingPlayer(
    callId: String,
    loadAudio: suspend (callId: String) -> ByteArray,
    modifier: Modifier = Modifier,
) {
    var isPlaying by remember { mutableStateOf(false) }
    var isPrepared by remember { mutableStateOf(false) }
    var isLoading by remember { mutableStateOf(true) }
    var errorRes by remember { mutableStateOf<Int?>(null) }
    var currentPosition by remember { mutableIntStateOf(0) }
    var duration by remember { mutableIntStateOf(0) }
    var progress by remember { mutableFloatStateOf(0f) }

    val mediaPlayer = remember { MediaPlayer() }
    val currentLoadAudio by rememberUpdatedState(loadAudio)

    DisposableEffect(mediaPlayer) {
        onDispose {
            try {
                if (mediaPlayer.isPlaying) {
                    mediaPlayer.stop()
                }
                mediaPlayer.reset()
                mediaPlayer.release()
            } catch (_: IllegalStateException) {
                // Already released — nothing left to clean up
            }
        }
    }

    LaunchedEffect(callId) {
        isLoading = true
        isPrepared = false
        isPlaying = false
        errorRes = null
        val audio = try {
            currentLoadAudio(callId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            errorRes = if (e.code == 404) R.string.recording_no_recording else R.string.admin_recording_load_failed
            isLoading = false
            return@LaunchedEffect
        } catch (_: Exception) {
            errorRes = R.string.admin_recording_load_failed
            isLoading = false
            return@LaunchedEffect
        }

        mediaPlayer.reset()
        mediaPlayer.setOnPreparedListener { mp ->
            duration = mp.duration
            isPrepared = true
            isLoading = false
        }
        mediaPlayer.setOnErrorListener { _, _, _ ->
            errorRes = R.string.admin_recording_load_failed
            isLoading = false
            isPlaying = false
            true
        }
        mediaPlayer.setOnCompletionListener {
            isPlaying = false
            currentPosition = 0
            progress = 0f
        }
        mediaPlayer.setDataSource(ByteArrayMediaDataSource(audio))
        mediaPlayer.prepareAsync()
    }

    // Update progress while playing
    LaunchedEffect(isPlaying) {
        while (isPlaying) {
            try {
                currentPosition = mediaPlayer.currentPosition
                progress = if (duration > 0) {
                    currentPosition.toFloat() / duration.toFloat()
                } else {
                    0f
                }
            } catch (_: Exception) {
                isPlaying = false
            }
            delay(250L)
        }
    }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("recording-player"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.admin_recording_playback),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )

            Spacer(Modifier.height(12.dp))

            when {
                isLoading -> {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(32.dp)
                            .testTag("recording-loading"),
                    )
                }

                errorRes != null -> {
                    Text(
                        text = stringResource(errorRes ?: R.string.admin_recording_load_failed),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.testTag("recording-error"),
                    )
                }

                isPrepared -> {
                    // Progress bar
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("recording-progress"),
                    )

                    Spacer(Modifier.height(8.dp))

                    // Time display
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = formatDuration(currentPosition),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("recording-current-time"),
                        )
                        Text(
                            text = formatDuration(duration),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("recording-total-time"),
                        )
                    }

                    Spacer(Modifier.height(8.dp))

                    // Controls
                    Row(
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Rewind 15s
                        IconButton(
                            onClick = {
                                val newPos = (mediaPlayer.currentPosition - 15_000).coerceAtLeast(0)
                                mediaPlayer.seekTo(newPos)
                                currentPosition = newPos
                                progress = if (duration > 0) newPos.toFloat() / duration.toFloat() else 0f
                            },
                            modifier = Modifier.testTag("recording-rewind"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.FastRewind,
                                contentDescription = stringResource(R.string.admin_recording_seek_back),
                            )
                        }

                        Spacer(Modifier.width(8.dp))

                        // Play / Pause
                        IconButton(
                            onClick = {
                                if (isPlaying) {
                                    mediaPlayer.pause()
                                    isPlaying = false
                                } else {
                                    mediaPlayer.start()
                                    isPlaying = true
                                }
                            },
                            modifier = Modifier
                                .size(48.dp)
                                .testTag("recording-play-pause"),
                        ) {
                            Icon(
                                imageVector = if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                                contentDescription = if (isPlaying) {
                                    stringResource(R.string.admin_recording_pause)
                                } else {
                                    stringResource(R.string.admin_recording_play)
                                },
                                modifier = Modifier.size(36.dp),
                            )
                        }

                        Spacer(Modifier.width(8.dp))

                        // Forward 15s
                        IconButton(
                            onClick = {
                                val newPos = (mediaPlayer.currentPosition + 15_000).coerceAtMost(duration)
                                mediaPlayer.seekTo(newPos)
                                currentPosition = newPos
                                progress = if (duration > 0) newPos.toFloat() / duration.toFloat() else 0f
                            },
                            modifier = Modifier.testTag("recording-forward"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.FastForward,
                                contentDescription = stringResource(R.string.admin_recording_seek_forward),
                            )
                        }

                        Spacer(Modifier.width(8.dp))

                        // Stop
                        IconButton(
                            onClick = {
                                mediaPlayer.pause()
                                mediaPlayer.seekTo(0)
                                isPlaying = false
                                currentPosition = 0
                                progress = 0f
                            },
                            modifier = Modifier.testTag("recording-stop"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Stop,
                                contentDescription = stringResource(R.string.admin_recording_stop),
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Format milliseconds to mm:ss display string.
 */
private fun formatDuration(millis: Int): String {
    val totalSeconds = millis / 1000
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "%d:%02d".format(minutes, seconds)
}

/** Serves an in-memory recording to [MediaPlayer] without touching disk. */
private class ByteArrayMediaDataSource(private val data: ByteArray) : MediaDataSource() {
    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (position >= data.size) return -1
        val start = position.toInt()
        val count = minOf(size, data.size - start)
        System.arraycopy(data, start, buffer, offset, count)
        return count
    }

    override fun getSize(): Long = data.size.toLong()

    override fun close() = Unit
}
