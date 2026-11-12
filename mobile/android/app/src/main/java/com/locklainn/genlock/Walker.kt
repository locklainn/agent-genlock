package com.locklainn.genlock

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Walks TJ through the pending items one at a time, the way a person would: it reads one, listens
 * for his response, and only then moves on. "next" skips, "repeat" reads it again, "send" (or
 * "that's it", or "stop") sends the answers so far as one batch and ends the walk; anything else is
 * his answer. Silence after an update moves on; silence after a question asks it once more, then
 * pauses the walk with the question still first in line. Nothing that arrives meanwhile interrupts:
 * Link merges it into the queue.
 */
class Walker(private val ctx: Context, private val link: Link, private val tts: () -> TextToSpeech?) {
    enum class Phase { IDLE, SPEAKING, LISTENING }

    val active = MutableStateFlow(false)
    val phase = MutableStateFlow(Phase.IDLE)
    /** What the recognizer is hearing right now, to show under the item. */
    val hearing = MutableStateFlow("")
    /** The words being read out, and how far the voice has got (a character index), for the live caption. */
    val spoken = MutableStateFlow("")
    val spokenTo = MutableStateFlow(0)

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var repeats = 0
    /** Bumped on every step and every stop, so a late callback from a step already left does nothing. */
    private var token = 0

    companion object {
        /** Dictating a message: a reply that arrives now waits until the mic is off. */
        val dictating = MutableStateFlow(false)
    }

    fun start() {
        if (active.value || link.pending.value.isEmpty()) return
        active.value = true
        link.walking = true
        link.heardKeys.clear()
        link.walked.value = emptyList()
        AudioHold.take(ctx, AudioHold.REPLY)
        repeats = 0
        speakCurrent()
    }

    /** Hear this one next: moves it to the front and starts there. */
    fun jumpTo(item: Item) {
        stopAll()
        link.moveFirst(item)
        if (active.value) { repeats = 0; speakCurrent() } else start()
    }

    /** The spoken buttons, for the screen. */
    fun repeat() { if (active.value) { stopAll(); speakCurrent() } }
    fun next() { val i = current() ?: return; stopAll(); advance(i, if (i.isQuestion) Answer(i, skipped = true) else null) }
    fun answer(text: String) { val i = current() ?: return; stopAll(); advance(i, Answer(i, text.trim())) }

    /** Send what has been answered so far, as one batch, and end the walk. Unheard items stay. */
    fun flush() {
        stopAll()
        end()
        link.sendAnswers()
    }

    /** Stop for now: answers stay held, the current item stays first in line. */
    fun pause() { stopAll(); end() }

    /** The voice reached [end] in the text it is reading. */
    fun range(id: String, end: Int) = main.post {
        if (id.removePrefix("walk-").toIntOrNull() == token) spokenTo.value = end
    }.let { }

    fun utteranceDone(id: String) = main.post {
        val my = id.removePrefix("walk-").toIntOrNull() ?: return@post
        if (my == token && active.value) current()?.let { listen(it) }
    }.let { }

    private fun current() = if (active.value) link.pending.value.firstOrNull() else null

    private fun end() {
        active.value = false
        link.walking = false
        AudioHold.drop(AudioHold.REPLY)
    }

    private fun speakCurrent() {
        val item = current() ?: run { flush(); return }
        val my = ++token
        phase.value = Phase.SPEAKING
        hearing.value = ""
        val text = item.spoken().replace(Regex("[*`#_]"), "")
        spoken.value = text
        spokenTo.value = 0
        if (tts()?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "walk-$my") != TextToSpeech.SUCCESS) {
            main.post { if (my == token) listen(item) }
        }
    }

    private fun advance(item: Item, answer: Answer?) {
        repeats = 0
        link.heard(item, answer)
        if (active.value) speakCurrent()
    }

    private fun silence(item: Item) {
        when {
            !item.isQuestion -> advance(item, null)
            repeats == 0 -> { repeats++; speakCurrent() }
            else -> { pause(); link.flash.value = "Paused on a question. Tap Walk to pick it back up." }
        }
    }

    private fun handle(item: Item, heard: String) {
        if (heard.isBlank()) return silence(item)
        when (val s = WalkPlan.said(heard)) {
            Said.Next -> advance(item, if (item.isQuestion) Answer(item, skipped = true) else null)
            Said.Repeat -> speakCurrent()
            Said.Flush -> flush()
            is Said.Reply -> advance(item, Answer(item, s.text))
        }
    }

    private fun listen(item: Item) {
        val granted = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!granted || !SpeechRecognizer.isRecognitionAvailable(ctx)) {
            if (item.isQuestion) { pause(); link.flash.value = "Genlock needs the microphone to hear your answer." } else advance(item, null)
            return
        }
        val my = token
        phase.value = Phase.LISTENING
        AudioHold.take(ctx, AudioHold.MIC)
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            private fun done(text: String?) {
                if (my != token) return
                release()
                handle(item, text.orEmpty())
            }
            override fun onResults(results: Bundle?) = done(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
            override fun onPartialResults(partial: Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { if (my == token) hearing.value = it }
            }
            override fun onError(error: Int) = done(null)
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
            // An answer may have a pause in it; honoured by some recognizers only.
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L))
    }

    private fun release() {
        recognizer?.destroy()
        recognizer = null
        AudioHold.drop(AudioHold.MIC)
        phase.value = Phase.IDLE
    }

    private fun stopAll() {
        token++
        tts()?.stop()
        release()
        hearing.value = ""
    }
}
