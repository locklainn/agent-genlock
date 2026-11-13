package com.locklainn.genlock

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class ClipsTest {
    private fun clips() = Clips(Files.createTempDirectory("clips").toFile(), keep = 3)

    @Test fun playsInOrderThenEnds() {
        val c = clips()
        assertEquals(Clips.Next.Wait, c.next("r-0", 0))
        c.add("r-0", 1, "Second.", byteArrayOf(2))
        assertEquals("clip 0 not here yet, so wait even though 1 is", Clips.Next.Wait, c.next("r-0", 0))
        c.add("r-0", 0, "First.", byteArrayOf(1))
        assertEquals("First.", (c.next("r-0", 0) as Clips.Next.Play).clip.text)
        assertEquals("Second.", (c.next("r-0", 1) as Clips.Next.Play).clip.text)
        assertEquals(Clips.Next.Wait, c.next("r-0", 2))
        c.done("r-0", 2)
        assertEquals(Clips.Next.End, c.next("r-0", 2))
    }

    @Test fun failedMeansTheBuiltInVoice() {
        val c = clips()
        c.failed("r-1")
        assertEquals(Clips.Next.Failed, c.next("r-1", 0))
        assertTrue(c.known("r-1"))
    }

    @Test fun oldItemsAreDroppedWithTheirFiles() {
        val c = clips()
        c.add("a", 0, "A.", byteArrayOf(1))
        val file = (c.next("a", 0) as Clips.Next.Play).clip.file
        listOf("b", "c", "d").forEach { c.add(it, 0, "x", byteArrayOf(1)) }
        assertTrue(!c.known("a") && !file.exists())
    }
}
