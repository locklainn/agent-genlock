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
    /** Where focus changes are reported (the bridge log, through Link.diag). */
    var log: ((String) -> Unit)? = null

    /**
     * Another app took focus back (the music resumed itself, the car head unit, a call): we no longer
     * hold it. Ignoring this left `holding` true for good, and the music played over every item after
     * (TJ, 2026-11-13, in a Ford truck over Bluetooth: "something is glitchy about audio focus").
     */
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(speech).setOnAudioFocusChangeListener({ change ->
            holding = change == AudioManager.AUDIOFOCUS_GAIN
            log?.invoke("audio focus: ${when (change) {
                AudioManager.AUDIOFOCUS_GAIN -> "gained"
                AudioManager.AUDIOFOCUS_LOSS -> "lost"
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "lost for now"
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "asked to duck"
                else -> "change $change"
            }}")
        }, Handler(Looper.getMainLooper())).build()

    /**
     * Set the audio state fresh for each item and each clip, rather than trusting what the walk
     * started with: ask for focus again every time while it is needed. Asking while holding it is a
     * no-op for Android; asking after a head unit or the music quietly took it back gets it again.
     */
    fun renew(ctx: Context) = main.post {
        if (reasons.isEmpty()) return@post
        audio = audio ?: ctx.applicationContext.getSystemService(AudioManager::class.java)
        val was = holding
        holding = audio?.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (!was || !holding) log?.invoke("audio focus renewed: ${if (holding) "granted" else "refused"}${if (!was) " (had been lost)" else ""}")
    }.let { }

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
