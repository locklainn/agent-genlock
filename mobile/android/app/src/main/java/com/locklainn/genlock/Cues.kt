package com.locklainn.genlock

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * Four short sounds, so you can follow a conversation with the phone in your pocket:
 *  - sent:    two notes rising (the laptop has your message)
 *  - started: a double tap on one note (the Assistant has picked it up and is working)
 *  - done:    three notes rising to a resolve (the reply is here)
 *  - failed:  two notes falling (your message did not reach the laptop: it waits with Retry)
 *  - listening: one bright ding (the answer sheet's mic is on: talk)
 *  - answered:  two quick high notes (your answer to a question went)
 * Synthesised once as sine notes with a soft attack and decay; no sound files.
 */
object Cues {
    private const val RATE = 44100

    private val sent by lazy { tones(listOf(660.0 to 70, 990.0 to 110)) }
    // As loud as the others and unlike them: TJ did not notice the single soft note it used to be.
    private val started by lazy { tones(listOf(587.33 to 90, 0.0 to 60, 587.33 to 140)) }
    private val failed by lazy { tones(listOf(493.88 to 160, 349.23 to 300), volume = 0.35) }
    private val done by lazy { tones(listOf(523.25 to 80, 659.25 to 80, 783.99 to 180)) }

    /** How long [done] lasts, so speech can start after it rather than over it. */
    const val DONE_MS = 360L

    fun sent() = play(sent)
    fun started() = play(started)
    fun done() = play(done)
    fun failed() = play(failed)
    private val listening by lazy { tones(listOf(1046.5 to 150)) }
    private val answered by lazy { tones(listOf(1318.5 to 60, 1568.0 to 170)) }
    fun listening() = play(listening)
    fun answered() = play(answered)

    private fun tones(notes: List<Pair<Double, Int>>, volume: Double = 0.3): ShortArray {
        val out = ArrayList<Short>()
        for ((hz, ms) in notes) {
            val n = RATE * ms / 1000
            val attack = RATE * 8 / 1000
            for (i in 0 until n) {
                // Ramp in over 8 ms, fade out over the rest: no clicks between notes.
                val env = min(1.0, i.toDouble() / attack) * (1.0 - i.toDouble() / n).let { it * it }
                out.add((sin(2 * PI * hz * i / RATE) * env * volume * Short.MAX_VALUE).toInt().toShort())
            }
        }
        return out.toShortArray()
    }

    private fun play(pcm: ShortArray) {
        runCatching {
            val track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track.write(pcm, 0, pcm.size)
            track.setNotificationMarkerPosition(pcm.size)
            track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(t: AudioTrack) { t.release() }
                override fun onPeriodicNotification(t: AudioTrack) {}
            })
            track.play()
        }.onFailure { android.util.Log.w("GenlockCues", "cue failed", it) }
    }
}
