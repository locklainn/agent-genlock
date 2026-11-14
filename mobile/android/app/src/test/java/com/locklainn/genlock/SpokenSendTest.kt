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
        s.heard("send", 61_000)                     // "send" on its own: send the answers so far
        assertEquals("", s.ready(62_200))
    }

    @Test fun theWordsARecognizerWritesForALoneSendCountAsSend() {
        val s = SpokenSend(quietMs = 1200)
        s.heard("Yes ship it sent", 0)
        assertEquals("Yes ship it", s.ready(1200))
        s.reset(); s.heard("Sand.", 0)
        assertEquals("", s.ready(1200))
    }

    @Test fun aSendTheRecognizerDropsWhenItSettlesStillCounts() {
        // Measured: the live partial shows "Yes send", then the settled phrase is just "Yes".
        val s = SpokenSend(quietMs = 1200)
        s.heard("Yes", 0)
        s.heard("Yes send", 300)
        s.heard("Yes.", 600)                         // settled, the send dropped
        assertEquals("Yes", s.ready(1500))
        assertEquals(true, s.dropped)
        s.heard("Yes. And one more thing", 2000)     // real new words still start over
        assertNull(s.ready(9000))
    }
}
