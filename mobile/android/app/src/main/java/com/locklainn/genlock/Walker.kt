package com.locklainn.genlock

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.util.Log
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
 * his answer once it ends in "send"; words without it open in the answer sheet to finish, so a pause
 * never sends. Silence after an update moves on; silence after a question asks it once more, then
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
    /** The Genlock-voice sentence playing now, shown whole as the caption; empty when the built-in voice reads. */
    val sentence = MutableStateFlow("")
    /** The question waiting for TJ's answer: its item has been read, so the answer sheet is open. Lives in Link, so it survives a rebuilt screen. */
    val asking get() = link.asking
    /** The wait before the walk moves on after an update, for the bar that drains over it; null when none. */
    val countdown = MutableStateFlow<Countdown?>(null)
    data class Countdown(val from: Long, val ms: Long)

    private val main = Handler(Looper.getMainLooper())
    init { AudioHold.log = { link.diag(it) } }
    private var recognizer: SpeechRecognizer? = null
    private var player: MediaPlayer? = null
    private var repeats = 0
    /** Bumped on every step and every stop, so a late callback from a step already left does nothing. */
    private var token = 0

    companion object {
        /**
         * How long an item waits for its first Genlock-voice clip before the phone's own voice reads it.
         * A warm speaker has it in ~2s; past this the wait is heard as a stall (TJ, in the car).
         */
        const val WAIT_MS = 5_000L
        /** Longest wait for the speaker to be clear (see whenMediaRoute) before speaking anyway. */
        const val ROUTE_WAIT_MS = 2_500L
        /** The recognizer's tone comes after it stops, usually ~150ms, sometimes later: watch for it this long. */
        const val TONE_DUE_MS = 1_500L
        /** Android keeps media on speaker-safe ~440ms after a tone ends (measured on the Pixel 10 Pro). */
        const val SOUND_TAIL_MS = 600L
        /**
         * Clips play as media, not as the assistant: media goes to the deep-buffer output, which a
         * notification tone on the primary output does not move to speaker-safe (unproved: the
         * diag lines in the bridge log show which speaker each clip played on).
         */
        val CLIP: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        /**
         * For a captured route (Android Auto and the like take media and speech alike, 2026-11-13 in
         * TJ's Ford): a car plays navigation prompts over whatever source is on.
         */
        val GUIDANCE: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        /** Tones that move media to speaker-safe while they play. */
        private val SOUNDS = setOf(AudioAttributes.USAGE_NOTIFICATION, AudioAttributes.USAGE_NOTIFICATION_EVENT,
            AudioAttributes.USAGE_ASSISTANCE_SONIFICATION, AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        /** How long the arrival screen shows before the walk starts. */
        const val ARRIVE_MS = 2_400L
        const val ARRIVE_CAP_MS = 6_000L
        /** How long the arrival line waits for its Genlock-voice clip before the built-in voice says it. */
        const val LINE_WAIT_MS = 2_500L
        /** After an update is read: how long the walk waits for a word from TJ before it moves on. */
        const val MOVE_ON_MS = 4_000L
        /** Dictating a message: a reply that arrives now waits until the mic is off. */
        val dictating = MutableStateFlow(false)
        /** A keystroke counts as typing for this long. */
        const val TYPING_MS = 20_000L
        /** TJ is writing a message: a draft with the keyboard in it, or typing just now. News never takes the screen from him then. */
        val composing = MutableStateFlow(false)
        /** Replies that came in while he was writing or talking: a small notice shows them, and they open once he sends. */
        val held = MutableStateFlow(0)
    }

    /**
     * A reply came in: announce it on the arrival screen, then start the walk, so TJ is led in rather
     * than dropped straight into a question. A walk already on just picks the new items up in place.
     */
    fun arrive() {
        // An open answer sheet is never closed by news: the new items wait their turn in the queue.
        val skip = when {
            active.value -> "a walk is on"
            link.pending.value.isEmpty() -> "nothing pending"
            link.arriving.value != null -> "already showing"
            link.asking.value != null -> "answer sheet open"
            else -> null
        }
        if (skip != null) { link.diag("arrival skipped: $skip"); return }
        val q = link.pending.value
        val status = link.lines.value.lastOrNull { it.who == Who.ME }?.text?.trim()?.startsWith("Status update", ignoreCase = true) == true
        val quiet = !speakOn()
        val now = System.currentTimeMillis()
        // A status report opens with the period it covers; the lead-in is used once.
        val lead = if (status) link.statusLead.also { link.statusLead = null } else null
        val a = Arrival(q.size, q.count { it.isQuestion }, q.map { it.project }.filter { it.isNotBlank() }.distinctBy { it.lowercase() }, status, now, quiet,
            lead = lead, asOf = WalkPlan.staleSince(q, now))
        link.arriving.value = a
        link.diag("arrival shown: ${a.items} items${if (quiet) ", speaker off: silent" else ""}")
        // The screen shows for ARRIVE_MS and says the count aloud; the walk starts once both are over,
        // so its first item never talks over the readout. A readout that never reports back is not waited on past ARRIVE_CAP_MS.
        var shown = false
        var said = false
        val go = { if (shown && said && link.arriving.value === a) start() }
        arrivalSaid = { said = true; go() }
        main.postDelayed({ shown = true; go() }, ARRIVE_MS)
        main.postDelayed({ said = true; go() }, ARRIVE_CAP_MS)
        // Speaker off: the line is shown, not said, and the walk that follows is silent too.
        if (quiet) { arrivalDone(); return }
        val line = WalkPlan.arrivalSpoken(a, now, link.conn.value == Conn.CONNECTED && link.laptop.value != "offline")
        // In the Genlock voice: the bridge voiced this line with the reply (same id), else it is asked for now.
        val id = "arrive:$line"
        if (!link.clips.known(id)) link.askClips(id, line)
        sayLine(token, a, id, 0, System.currentTimeMillis()) {
            if (tts()?.speak(line, TextToSpeech.QUEUE_FLUSH, null, "arrive-${a.at}") != TextToSpeech.SUCCESS) arrivalDone()
        }
    }

    /** Play the arrival line's clips; [builtIn] if none come within [LINE_WAIT_MS]. Reports [arrivalDone] at the end. */
    private fun sayLine(my: Int, a: Arrival, id: String, played: Int, since: Long, builtIn: () -> Unit) {
        if (my != token || link.arriving.value !== a) return
        when (val n = link.clips.next(id, played)) {
            is Clips.Next.Play -> play(my, n.clip) { sayLine(my, a, id, played + 1, System.currentTimeMillis(), builtIn) }
            Clips.Next.End -> arrivalDone()
            Clips.Next.Failed -> if (played == 0) { link.diag("arrival line: failed: built-in voice"); builtIn() } else arrivalDone()
            Clips.Next.Wait ->
                if (System.currentTimeMillis() - since > LINE_WAIT_MS) {
                    if (played == 0) { link.diag("arrival line: no clip within ${LINE_WAIT_MS}ms: built-in voice"); builtIn() } else arrivalDone()
                }
                else main.postDelayed({ sayLine(my, a, id, played, since, builtIn) }, 100)
        }
    }

    private var arrivalSaid: (() -> Unit)? = null

    /** Replies are read aloud (the speaker button in the top bar). */
    private fun speakOn() = ctx.getSharedPreferences("genlock-ui", Context.MODE_PRIVATE).getBoolean("speak", true)

    /** The arrival readout finished (or was stopped). */
    fun arrivalDone() = main.post { arrivalSaid?.invoke(); arrivalSaid = null }.let { }

    fun start() = begin(fresh = true)

    /** [fresh]: a new walk, so the steps heard last time are cleared; false carries on from a rewind. */
    private fun begin(fresh: Boolean) {
        link.arriving.value = null
        if (active.value || link.pending.value.isEmpty()) return
        active.value = true
        link.walking = true
        // The steps heard stay on the bar (Play after Pause must not wipe them); a new update clears them as it arrives (Link.mergeItems).
        if (fresh) link.heardKeys.clear()
        AudioHold.take(ctx, AudioHold.REPLY)
        repeats = 0
        speakCurrent()
    }

    /**
     * Go back to step [to] (0: start the whole walk over) and play on from there, whether the walk
     * is playing, paused or finished.
     */
    fun rewind(to: Int) {
        stopAll()
        asking.value = null
        link.rewind(to)
        diag("rewind to step ${to + 1}")
        if (active.value) { repeats = 0; speakCurrent() } else begin(fresh = false)
    }

    /** Hear this one next: moves it to the front and starts there. */
    fun jumpTo(item: Item) {
        stopAll()
        link.moveFirst(item)
        if (active.value) { repeats = 0; speakCurrent() } else start()
    }

    /** The spoken buttons, for the screen. */
    // From the answer sheet these also work on a paused walk: answering or skipping carries it on.
    fun repeat() { resume(); if (active.value) { stopAll(); speakCurrent() } }
    fun next() { resume(); val i = current()?.takeIf { stillAsked(it) } ?: return; stopAll(); advance(i, if (i.isQuestion) Answer(i, skipped = true) else null) }
    fun answer(text: String) { resume(); val i = current()?.takeIf { stillAsked(it) } ?: return; stopAll(); advance(i, Answer(i, text.trim())) }

    /** Close the answer sheet: the walk pauses with the question still first in line. */
    fun dismiss() { pause(); asking.value = null }

    /** An answer from the sheet belongs to the item it shows: if that item is gone from the queue, the sheet just closes. */
    private fun stillAsked(i: Item): Boolean {
        val shown = asking.value ?: return true
        if (shown.id == i.id) return true
        asking.value = null
        return false
    }

    /** A paused walk carries on from its first item, without starting over. */
    private fun resume() {
        if (active.value || link.pending.value.isEmpty()) return
        active.value = true
        link.walking = true
        AudioHold.take(ctx, AudioHold.REPLY)
    }

    /** A line for the bridge log, so a phone test can be read from the laptop. */
    fun diag(text: String) = link.diag(text)

    /** The words said for [id] before its answer sheet opened, once; "" when none. */
    fun takeSeed(id: String): String {
        val s = link.askSeed.value?.takeIf { it.first == id }?.second.orEmpty()
        link.askSeed.value = null
        return s
    }

    /** The conversation, for a review's images: each arrives as a file line the bridge sent with the reply. */
    val lines get() = link.lines

    /** Send what has been answered so far, as one batch, and end the walk. Unheard items stay. */
    fun flush() {
        stopAll()
        asking.value = null
        end()
        link.sendAnswers()
    }

    /** Stop for now: answers stay held, the current item stays first in line. */
    fun pause() { if (link.arriving.value != null) { link.arriving.value = null; tts()?.stop() }; stopAll(); end() }

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

    /**
     * Read the first item: in the Genlock voice, a clip per sentence as they arrive from the Mac,
     * captioned a sentence at a time. If its first clip is not here within [WAIT_MS], or the Mac
     * says none are coming, the phone's own voice reads it instead.
     */
    private fun speakCurrent() {
        val item = current() ?: run { flush(); return }
        val my = ++token
        // The question opens only once its item has been read; a repeat closes it while it is read again.
        asking.value = null
        phase.value = Phase.SPEAKING
        hearing.value = ""
        spoken.value = ""
        spokenTo.value = 0
        sentence.value = ""
        // Reading aloud is off: nothing is said. The item shows whole, and the walk goes on from the screen.
        if (!speakOn()) {
            spoken.value = item.spoken().replace(Regex("[*`#_]"), "")
            spokenTo.value = spoken.value.length
            link.diag("item ${item.id}: speaker off: shown, not read")
            return listen(item)
        }
        AudioHold.renew(ctx)
        val ids = listOfNotNull(if (item.late) "late:${item.project}" else null, item.id)
        ids.filterNot { link.clips.known(it) }.forEach { link.askClips(it) }
        whenMediaRoute(my, System.currentTimeMillis()) { playFrom(my, item, ids, 0, 0, System.currentTimeMillis()) }
    }

    /**
     * Start an item's speech only once the speaker is ours at full quality. Stopping the recognizer
     * that listened after the last item makes Google's speech service play its "stopped listening"
     * tone, a notification sound; while a notification sounds over media, Android moves the media to
     * "speaker-safe", a limited speaker path, and moves it back ~0.4s after the tone ends. Speech
     * started at once began thin and distant and then filled out (TJ, 2026-11-12: "the project+goal
     * read", an item's first clip; the phone's audio log showed it moved speaker -> speaker-safe ->
     * speaker around the tone). A fixed 400ms wait missed tones that came later. The same holds
     * for our own cues, and over Bluetooth for the recognizer's call link (SCO). So wait out all
     * three, at most [ROUTE_WAIT_MS], then speak anyway.
     */
    private fun whenMediaRoute(my: Int, since: Long, then: () -> Unit) {
        if (my != token) return
        val now = System.currentTimeMillis()
        val waited = now - since
        val am = ctx.getSystemService(AudioManager::class.java)
        if (am != null && am.activePlaybackConfigurations.any { it.audioAttributes.usage in SOUNDS }) lastSound = now
        // The recognizer's tone can come a second after it stops: until it has been heard, keep waiting.
        val toneDue = now - micOffAt < TONE_DUE_MS && lastSound < micOffAt
        val busy = toneDue || now - lastSound < SOUND_TAIL_MS || onSafeSpeaker(am) || onCallRoute(am)
        if (!busy) {
            link.diag("item start: waited ${waited}ms (mic off ${if (micOffAt > 0) now - micOffAt else -1}ms ago, last tone ${if (lastSound > 0) now - lastSound else -1}ms ago)")
            return then()
        }
        if (waited > ROUTE_WAIT_MS) {
            link.diag("item start: speaker still not clear after ${waited}ms (toneDue=$toneDue safe=${onSafeSpeaker(am)} call=${onCallRoute(am)}): speaking anyway")
            return then()
        }
        main.postDelayed({ whenMediaRoute(my, since, then) }, 50)
    }

    /** When the recognizer last stopped, and when a tone (anyone's notification sound) last played. */
    private var micOffAt = 0L
    private var lastSound = 0L

    /** Speech would go out on speaker-safe right now, the limited speaker path a notification sound forces. */
    private fun onSafeSpeaker(am: AudioManager?): Boolean {
        if (am == null || Build.VERSION.SDK_INT < 33) return false
        return am.getAudioDevicesForAttributes(AudioHold.speech).any { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE }
    }

    /** Speech would go out over a Bluetooth call link (SCO) right now, not media. */
    private fun onCallRoute(am: AudioManager?): Boolean {
        am ?: return false
        if (am.mode != AudioManager.MODE_NORMAL) return true
        if (Build.VERSION.SDK_INT >= 33) {
            return am.getAudioDevicesForAttributes(AudioHold.speech).any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        }
        @Suppress("DEPRECATION") return am.isBluetoothScoOn
    }

    private fun playFrom(my: Int, item: Item, ids: List<String>, at: Int, played: Int, since: Long) {
        if (my != token) return
        if (at >= ids.size) return listen(item)
        val body = at == ids.size - 1
        // The "came in" line is a nicety: if it does not come, go on to the item.
        fun giveUp() = when {
            body && played == 0 -> { link.diag("item ${ids[at]}: no clip within ${WAIT_MS}ms: built-in voice"); builtIn(my, item) }
            !body -> playFrom(my, item, ids, at + 1, 0, System.currentTimeMillis())
            else -> { link.diag("item ${ids[at]}: clip ${played} did not come within ${WAIT_MS}ms: item cut short"); listen(item) }
        }
        when (val n = link.clips.next(ids[at], played)) {
            is Clips.Next.Play -> play(my, n.clip) { playFrom(my, item, ids, at, played + 1, System.currentTimeMillis()) }
            Clips.Next.End -> playFrom(my, item, ids, at + 1, 0, System.currentTimeMillis())
            Clips.Next.Failed -> giveUp()
            Clips.Next.Wait ->
                if (System.currentTimeMillis() - since > WAIT_MS) giveUp()
                else main.postDelayed({ playFrom(my, item, ids, at, played, since) }, 100)
        }
    }

    private fun play(my: Int, clip: Clips.Clip, then: () -> Unit) {
        sentence.value = clip.text
        // The audio state is set fresh for every clip: focus asked for again, attributes from where media goes now.
        AudioHold.renew(ctx)
        player?.release()
        val p = MediaPlayer()
        player = p
        val finish = { mp: MediaPlayer -> mp.release(); if (player === mp) player = null; main.post { if (my == token) then() }; Unit }
        p.setOnCompletionListener { finish(it) }
        p.setOnErrorListener { mp, _, _ -> finish(mp); true }
        runCatching {
            p.setAudioAttributes(clipAttributes())
            p.setDataSource(clip.file.path)
            p.prepare()
            val t0 = System.currentTimeMillis()
            // Where each clip actually plays, and every move: speaker-safe (type 24) is the thin sound.
            p.addOnRoutingChangedListener({ r ->
                val type = r.routedDevice?.type
                link.diag("clip ${clip.file.name} on $type at +${System.currentTimeMillis() - t0}ms${if (type == AudioDeviceInfo.TYPE_REMOTE_SUBMIX) " (remote submix: the car takes it, e.g. Android Auto)" else ""}")
            }, main)
            p.start()
        }.onFailure { finish(p) }
    }

    /**
     * Clips play as media (see CLIP), unless media is being captured right now: casting or projecting
     * routes media to REMOTE_SUBMIX, a virtual output nobody hears, and every clip went silent there
     * until the cast let go (TJ, 2026-11-13, bridge log: clips "on 25" from 22:26:50). Then they play
     * with the speech usage, which such a capture does not take.
     */
    private fun clipAttributes(): AudioAttributes {
        val am = ctx.getSystemService(AudioManager::class.java)
        if (am == null || Build.VERSION.SDK_INT < 33) return CLIP
        val captured = am.getAudioDevicesForAttributes(CLIP).any { it.type == AudioDeviceInfo.TYPE_REMOTE_SUBMIX }
        if (captured) link.diag("clip route captured: media goes to remote submix, playing as navigation guidance")
        return if (captured) GUIDANCE else CLIP
    }

    /** The phone's own voice, for an item whose clips did not come. */
    private fun builtIn(my: Int, item: Item) {
        val text = item.spoken().replace(Regex("[*`#_]"), "")
        sentence.value = ""
        spoken.value = text
        spokenTo.value = 0
        if (tts()?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "walk-$my") != TextToSpeech.SUCCESS) {
            main.post { if (my == token) listen(item) }
        }
    }

    private fun advance(item: Item, answer: Answer?) {
        repeats = 0
        asking.value = null
        link.heard(item, answer)
        if (active.value) speakCurrent()
    }

    private fun silence(item: Item) {
        when {
            !item.isQuestion -> advance(item, null)
            repeats == 0 -> { repeats++; speakCurrent() }
            else -> { pause(); link.flash.value = "Paused on the question. Answer it on screen, or close it to come back later." }
        }
    }

    private fun handle(item: Item, heard: String) {
        if (heard.isBlank()) return silence(item)
        when (val s = WalkPlan.saidOnPause(heard)) {
            Said.Next -> advance(item, if (item.isQuestion) Answer(item, skipped = true) else null)
            Said.Repeat -> speakCurrent()
            Said.Flush -> flush()
            is Said.Reply -> advance(item, Answer(item, s.text))
            is Said.Unsent -> hold(item, s.text)
        }
    }

    /**
     * TJ started answering and paused: the walk stops here, and his words open in the answer sheet,
     * whose mic carries on through every pause. Only "send" or the send button sends them.
     */
    private fun hold(item: Item, words: String) {
        stopAll()
        release()
        diag("held for send: \"${words.takeLast(60)}\"")
        link.askSeed.value = item.id to words
        asking.value = item
    }

    /**
     * An update: the walk waits MOVE_ON_MS, shown as a bar that drains, and moves on exactly when it
     * is empty. This timer is the only thing that moves an update on unanswered: no recognizer event
     * does. Only TJ's actual words stop it (then his words decide what happens).
     */
    private fun countDown(my: Int, item: Item) {
        // Silent, the bar is reading time: about 4 words a second, never under MOVE_ON_MS.
        val ms = if (speakOn()) MOVE_ON_MS else maxOf(MOVE_ON_MS, item.spoken().split(Regex("\\s+")).size * 250L + 1_500L)
        val cd = Countdown(System.currentTimeMillis(), ms)
        countdown.value = cd
        main.postDelayed({ if (my == token && countdown.value === cd && active.value) { stopAll(); advance(item, null) } }, ms)
    }

    private fun listen(item: Item) {
        val my = token
        // A question waits in the answer sheet for as long as TJ takes: its own mic listens until he
        // taps send, like the main one. No recognizer here, so no silence that re-reads it over him.
        if (item.isQuestion) { phase.value = Phase.IDLE; asking.value = item; return }
        // A step with something to open (a document, a link) stays until TJ taps next: no countdown,
        // and no mic whose silence would move it on (TJ, 2026-11-14).
        if (item.waitsForTap(WalkPlan.linksShown(item, link.lines.value, link.walked.value + link.pending.value))) {
            phase.value = Phase.IDLE
            diag("item ${item.id}: has something to open: waits for a tap")
            return
        }
        countDown(my, item)
        // Silent: no mic either (its tones would sound); Next, Pause and the bar carry the walk.
        if (!speakOn()) return
        val granted = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!granted || !SpeechRecognizer.isRecognitionAvailable(ctx)) {
            // An update moves on when its countdown runs out.
            return
        }
        phase.value = Phase.LISTENING
        AudioHold.take(ctx, AudioHold.MIC)
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            private fun done(text: String?) {
                if (my != token) return
                release()
                if (text.isNullOrBlank() && !item.isQuestion) {
                    // Nothing usable heard. Never move on early: a bar still running runs to empty; one that
                    // words had stopped (they came to nothing) starts again, full.
                    if (countdown.value == null) countDown(my, item)
                    return
                }
                handle(item, text.orEmpty())
            }
            override fun onResults(results: Bundle?) = done(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
            override fun onPartialResults(partial: Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let {
                    if (my != token) return@let
                    hearing.value = it
                    // Real words, not just sound: the walk waits for TJ instead of moving on under him.
                    if (it.isNotBlank()) countdown.value = null
                }
            }
            override fun onError(error: Int) = done(null)
            override fun onReadyForSpeech(params: Bundle?) {}
            // Sound is not speech (a cough, the room, the voice's own tail): only words stop the bar.
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
        if (recognizer != null) micOffAt = System.currentTimeMillis()
        recognizer?.destroy()
        recognizer = null
        AudioHold.drop(AudioHold.MIC)
        phase.value = Phase.IDLE
    }

    private fun stopAll() {
        token++
        countdown.value = null
        tts()?.stop()
        player?.release()
        player = null
        sentence.value = ""
        release()
        hearing.value = ""
    }
}
