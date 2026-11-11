package com.locklainn.genlock

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

/**
 * Pauses other apps' audio (Spotify, podcasts) while the app is talking with you: while you dictate,
 * while a dictated message waits for its reply, and while the reply is read aloud. One transient focus
 * request covers all three, so the music stays paused from the mic tap to the end of the readout and
 * resumes after. Letting go waits a moment, so the music does not blip back on between the steps.
 */
object AudioHold {
    const val MIC = "mic"
    const val WAITING = "waiting"
    const val REPLY = "reply"
    private const val GRACE_MS = 1500L

    val speech: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(speech).setOnAudioFocusChangeListener { }.build()

    private val main = Handler(Looper.getMainLooper())
    private val reasons = mutableSetOf<String>()
    private var holding = false
    private var audio: AudioManager? = null

    fun take(ctx: Context, reason: String) = main.post {
        audio = audio ?: ctx.applicationContext.getSystemService(AudioManager::class.java)
        reasons += reason
        main.removeCallbacks(letGo)
        if (!holding) holding = audio?.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }.let { }

    fun drop(reason: String) = main.post {
        reasons -= reason
        if (reasons.isEmpty()) { main.removeCallbacks(letGo); main.postDelayed(letGo, GRACE_MS) }
    }.let { }

    /** Stop pressed, or the app closing: let the music back now. */
    fun dropAll() = main.post { reasons.clear(); main.removeCallbacks(letGo); letGo.run() }.let { }

    private val letGo = Runnable {
        if (reasons.isNotEmpty() || !holding) return@Runnable
        holding = false
        audio?.abandonAudioFocusRequest(request)
    }
}
