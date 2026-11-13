package com.locklainn.genlock

import org.junit.Assert.assertEquals
import org.junit.Test

class OutboxTest {
    @Test fun unconfirmedMessagesComeBackAsNotDeliveredAndConfirmedOnesDoNot() {
        val lines = listOf(
            Line("a", Who.ME, "delivered", 1),
            Line("b", Who.ME, "still sending", 2, pending = true),
            Line("c", Who.ME, "already failed", 3, failed = true, file = "/x.jpg", mime = "image/jpeg"),
            Line("d", Who.ASSISTANT, "a reply", 4),
            Line("e", Who.ME, "picked up", 5, picked = true),
        )
        val back = Outbox.decode(Outbox.encode(lines))
        assertEquals(listOf("b", "c"), back.map { it.id })
        assertEquals(listOf(Stage.FAILED, Stage.FAILED), back.map { it.stage })
        assertEquals("/x.jpg", back[1].file)
        assertEquals(emptyList<Line>(), Outbox.decode(null))
    }

    @Test fun stagesFollowTheFlags() {
        assertEquals(Stage.SENDING, Line("a", Who.ME, "", 0, pending = true).stage)
        assertEquals(Stage.DELIVERED, Line("a", Who.ME, "", 0).stage)
        assertEquals(Stage.PICKED, Line("a", Who.ME, "", 0, picked = true).stage)
        assertEquals(Stage.FAILED, Line("a", Who.ME, "", 0, failed = true).stage)
    }
}
