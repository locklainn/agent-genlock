package com.locklainn.genlock

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Dictation that stays open until you stop it. Google's voice input screen ends after about two
 * seconds of silence, so it is not used. On Android 13+ this asks for a segmented session (the
 * recognizer keeps listening across pauses and hands back text a phrase at a time); anywhere that
 * ends early anyway, it quietly starts listening again until stop() is called.
 *
 * [onText] gets everything heard so far: the settled phrases, then the phrase still being spoken.
 */
class Dictation(
    private val context: Context,
    private val onText: (settled: String, partial: String) -> Unit,
    private val onListening: (Boolean) -> Unit,
    private val onProblem: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var wanted = false
    private var onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    private var segmented = Build.VERSION.SDK_INT >= 33
    private val settled = StringBuilder()
    private var failures = 0
    /** How long a segmented session may run. Overridable for testing: adb shell am start -n …/.MainActivity --ei minlen N */
    // The Pixel recognizer refuses more than 5 minutes (measured: 300000 accepted, 600000 refused).
    var minLength = 5 * 60_000

    val listening get() = wanted

    /** Starts listening; what was already heard (e.g. typed text) is kept in front. */
    fun start(prefix: String) {
        if (wanted) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) { onProblem("This phone has no speech recognizer."); return }
        settled.clear()
        settled.append(prefix.trim())
        wanted = true
        failures = 0
        onListening(true)
        session()
    }

    fun stop() {
        if (!wanted) return
        wanted = false
        recognizer?.stopListening()
        main.postDelayed({ if (!wanted) release() }, 1500)
        onListening(false)
    }

    fun destroy() { wanted = false; release() }

    private fun release() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun add(text: String?) {
        val t = text?.trim().orEmpty()
        if (t.isEmpty()) return
        if (settled.isNotEmpty()) settled.append(' ')
        settled.append(t)
    }

    private fun session() {
        if (!wanted) return
        release()
        val r = if (onDevice && Build.VERSION.SDK_INT >= 31) SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                else SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(listener)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Honoured by some recognizers, ignored by others: ask for long pauses anyway.
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 60_000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 60_000L)
        if (segmented && Build.VERSION.SDK_INT >= 33) {
            // The session lasts as long as this minimum; stop() ends it sooner.
            intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, minLength) // an Int: the Pixel recognizer reads a Long as 0
        }
        android.util.Log.i("GenlockDictation", "session onDevice=$onDevice segmented=$segmented minLength=$minLength")
        r.startListening(intent)
    }

    /** The recognizer ended on its own while the user still wants to talk: listen again. */
    private fun again() {
        if (wanted) main.postDelayed({ session() }, 100)
        else release()
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partial: Bundle?) {
            if (!wanted) return
            val p = partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
            onText(settled.toString(), p)
        }

        // A phrase finished inside a segmented session; the session carries on.
        override fun onSegmentResults(segment: Bundle) {
            if (!wanted) return
            failures = 0
            add(segment.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
            onText(settled.toString(), "")
        }

        override fun onEndOfSegmentedSession() { again() }

        override fun onResults(results: Bundle?) {
            if (!wanted) { release(); return }
            failures = 0
            add(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
            onText(settled.toString(), "")
            again()
        }

        override fun onError(error: Int) {
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> again()
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> { wanted = false; onListening(false); onProblem("Genlock needs the microphone permission.") }
                12, 13 -> { // language not supported / not downloaded on device: use the regular recognizer
                    if (onDevice) { onDevice = false; again() } else { wanted = false; onListening(false); onProblem("Speech recognition is not available for this language.") }
                }
                else -> {
                    // Some recognizers reject segmented sessions: retry once without, then keep trying gently.
                    failures++
                    if (failures == 2 && segmented) segmented = false
                    if (failures == 4 && onDevice) onDevice = false
                    if (failures > 8) { wanted = false; onListening(false); onProblem("Dictation stopped (error $error).") }
                    else if (wanted) main.postDelayed({ session() }, 300L * failures)
                }
            }
        }
    }
}
