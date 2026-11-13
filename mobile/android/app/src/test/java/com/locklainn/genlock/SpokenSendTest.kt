package com.locklainn.genlock

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Driven with the event shapes measured on the Pixel: "send" arrives as a live partial that never settles. */
class SpokenSendTest {
    @Test fun sendThatStaysAPartialStillSendsOnceItHasStoodTheQuietTime() {
        val s = SpokenSend(quietMs = 1200)
        s.heard("Yes ship", 0)
        s.heard("Yes ship it", 400)
        s.heard("Yes ship it send", 900)          // the live partial: the recognizer never finalizes it
        assertNull(s.ready(1500))                   // not yet: only 600 ms of quiet
        assertEquals("Yes ship it", s.ready(2100))  // 1200 ms after the last change
    }

    @Test fun moreWordsAfterSendStartTheWaitAgainAndSendIsNoLongerLast() {
        val s = SpokenSend(quietMs = 1200)
        s.heard("we should send", 0)
        s.heard("we should send it to Mia", 800)
        assertNull(s.ready(5000))
    }

    @Test fun theRecognizerSettlingTheSameWordsDoesNotRestartTheWait() {
        val s = SpokenSend(quietMs = 1200)
        s.heard("Use the blue one send", 0)
        s.heard("Use the blue one, send.", 1000)   // settled, punctuated: same answer
        assertEquals("Use the blue one", s.ready(1200))
    }

    @Test fun silenceAloneNeverSends() {
        val s = SpokenSend(quietMs = 1200)
        s.heard("I think the second option", 0)
        assertNull(s.ready(60_000))
        s.heard("send", 61_000)                     // "send" on its own is not an answer
        assertNull(s.ready(70_000))
    }
}
