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
    private var changedAt = 0L
    /**
     * The answer when "send" was last heard as the final word, normalized. Measured 2026-11-14: the
     * live partial shows "Yes send", then the recognizer settles the phrase as just "Yes", dropping
     * the short last word (TJ: "it shows SEND the word then disappears"; the settled lines in the
     * bridge log at 04:17:28, 04:17:48 and 04:20:01 have no "send"). So once heard, it sticks: a
     * settled version that only drops it keeps the send.
     */
    private var latched: String? = null
    /** Set when the recognizer dropped a "send" that was heard, so the log can confirm the cause. */
    var dropped = false
        private set
    /** Everything heard so far, for the log. */
    val lastHeard: String get() = text

    private fun norm(s: String) = s.lowercase().replace(Regex("[^a-z0-9' ]"), " ").replace(Regex("\\s+"), " ").trim()

    /** What the recognizer has now, everything heard: settled phrases then the live one. */
    fun heard(all: String, now: Long) {
        val t = all.trim()
        if (t == text) return
        val answer = WalkPlan.spokenSend(t)
        // The recognizer settled the same words without the "send" it showed a moment ago: keep it.
        if (answer == null && latched != null && norm(t) == latched) { dropped = true; return }
        val same = answer?.let { it == WalkPlan.spokenSend(text) } == true
        text = t
        latched = answer?.let { norm(it) }
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

    fun reset() { text = ""; changedAt = 0L; latched = null; dropped = false }

    companion object {
        /** How long "send" must stand as the last word before the visible send countdown starts. */
        const val QUIET_MS = 1_200L
    }
}
