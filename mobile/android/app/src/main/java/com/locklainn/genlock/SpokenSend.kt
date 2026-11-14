package com.locklainn.genlock

/**
 * Hands-free "send" for the answer sheet, without waiting on the recognizer to finish a phrase.
 *
 * Measured on the Pixel 10 Pro (logcat, 2026-11-12 14:13): with the 60s silence setting Dictation
 * asks for, the on-device recognizer does not finalize a phrase when TJ goes quiet; the last phrase
 * stayed a live partial until the app itself stopped listening. The old check only looked at
 * finalized phrases, so a "send" followed by silence was never seen.
 *
 * So this watches everything heard so far, settled and live alike: once its last word is "send"
 * (or "send it", "send that") and nothing has changed for [quietMs], it is ready. Any change after
 * that (more words, a correction from the recognizer) starts the wait again; a change that keeps
 * the same answer (the recognizer settling the same words) does not.
 */
class SpokenSend(private val quietMs: Long = QUIET_MS) {
    private var text = ""
    /** Everything heard so far, for the log. */
    val lastHeard: String get() = text
    private var changedAt = 0L

    /** What the recognizer has now, everything heard: settled phrases then the live one. */
    fun heard(all: String, now: Long) {
        val t = all.trim()
        if (t == text) return
        val same = WalkPlan.spokenSend(t)?.let { it == WalkPlan.spokenSend(text) } == true
        text = t
        if (!same) changedAt = now
    }

    /**
     * The answer, without "send", once "send" has been the last word for [quietMs]; null otherwise.
     * Empty when "send" was all that was said: send the answers so far, as the walk's own "send" does.
     */
    fun ready(now: Long): String? {
        val answer = WalkPlan.spokenSend(text) ?: return null
        return if (now - changedAt >= quietMs) answer else null
    }

    fun reset() { text = ""; changedAt = 0L }

    companion object {
        /** How long "send" must stand as the last word before the visible send countdown starts. */
        const val QUIET_MS = 1_200L
    }
}
