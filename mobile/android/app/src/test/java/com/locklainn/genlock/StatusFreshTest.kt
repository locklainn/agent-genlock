package com.locklainn.genlock

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

/** The heading wrap, stale updates and status-report rules (TJ, 2026-11-14). */
class StatusFreshTest {
    private val ny = TimeZone.getTimeZone("America/New_York")
    private val h = 3_600_000L
    /** 2026-11-14 08:00 New York. */
    private val morning = 1_794_661_200_000L
    private fun at(hour: Int, dayOffset: Int = 0) = morning + (hour - 8) * h + dayOffset * 24 * h
    private fun item(id: String, project: String, task: String, t: Long, q: Boolean = false) =
        Item(id, project, task, if (q) "question" else "update", "say $id", if (q) "ask $id?" else null, at = t)
    private fun ids(l: List<Item>) = l.map { it.id + if (it.late) "*" else "" }

    @Test fun headingKeepsItsLastTwoWordsTogether() {
        assertEquals("Your status report is in", WalkPlan.keepLastTwo("Your status report is in"))
        assertEquals("Tally replied", WalkPlan.keepLastTwo("Tally replied"))
        assertEquals("Solo", WalkPlan.keepLastTwo("Solo"))
    }

    @Test fun newerUpdateForAProjectReplacesItsOlderUpdatesWhateverTheTask() {
        val ahead = listOf(item("n1", "nightmaremode", "boss fight", at(1)), item("b1", "budget", "y", at(1)))
        val m = WalkPlan.merge(ahead, listOf(item("n2", "nightmaremode", "level select", at(7))), emptySet())
        assertEquals(listOf("n2", "b1"), ids(m))
    }

    @Test fun olderQuestionsOfTheProjectStayUnlessTheirOwnTaskIsReplaced() {
        val ahead = listOf(item("q1", "nightmaremode", "art", at(1), q = true), item("n1", "nightmaremode", "boss", at(1)))
        val m = WalkPlan.merge(ahead, listOf(item("n2", "nightmaremode", "levels", at(7))), emptySet())
        assertEquals(listOf("q1", "n2"), ids(m))
    }

    @Test fun updatesFromTheSameReplyAreAllKept() {
        val m = WalkPlan.merge(emptyList(), listOf(item("a", "genlock", "x", at(7)), item("b", "genlock", "y", at(7))), emptySet())
        assertEquals(listOf("a", "b"), ids(m))
    }

    @Test fun freshnessOnlyOnceAnHourOld() {
        assertNull(WalkPlan.asOf(at(7) + 30 * 60_000L, at(8), ny))
        assertEquals("As of 1:00 AM, 7 hours ago", WalkPlan.asOf(at(1), at(8), ny))
        assertEquals("As of yesterday 11:00 PM, 9 hours ago", WalkPlan.asOf(at(23, -1), at(8), ny))
        val q = listOf(item("a", "p", "x", at(1)), item("b", "p", "y", at(7) + 30 * 60_000L))
        assertEquals(at(1), WalkPlan.staleSince(q, at(8)))
        assertNull(WalkPlan.staleSince(q.drop(1), at(8)))
    }

    @Test fun arrivalSaysHowOldAndThatNothingNewerCame() {
        val a = Arrival(2, 1, listOf("p"), status = false, at = at(8), asOf = at(1))
        assertEquals("One update, one question. These are from 7 hours ago, and nothing newer has come in.", WalkPlan.arrivalSpoken(a, at(8), true))
        assertTrue(WalkPlan.arrivalSpoken(a, at(8), false).endsWith("there may be newer news."))
        assertEquals("One update, one question.", WalkPlan.arrivalSpoken(a.copy(asOf = null), at(8), true))
    }

    @Test fun leadNamesThePeriodCovered() {
        assertEquals("Here's your status report from last night.", WalkPlan.lead(at(23, -1), at(8), ny))
        assertEquals("Here's your status report from last night.", WalkPlan.lead(at(20, -1), at(7), ny))
        assertEquals("Here's your status report from overnight.", WalkPlan.lead(at(2), at(8), ny))
        assertEquals("Here's your status report from this morning.", WalkPlan.lead(at(9), at(13), ny))
        assertEquals("Here's your status report from the last 3 hours.", WalkPlan.lead(at(13), at(16), ny))
        assertEquals("Here's your status report from the last 20 minutes.", WalkPlan.lead(at(8) - 20 * 60_000L, at(8), ny))
        assertEquals("Here's your status report from the last 3 days.", WalkPlan.lead(at(8, -3), at(8), ny))
        assertEquals("Here's your status report.", WalkPlan.lead(0, at(8), ny))
        val a = Arrival(3, 1, emptyList(), status = true, at = at(8), lead = WalkPlan.lead(at(23, -1), at(8), ny))
        assertEquals("Here's your status report from last night. Two updates, one question.", WalkPlan.arrivalSpoken(a, at(8), true))
    }

    @Test fun statusRequestAsksForEveryOpenQuestionAndNamesThePeriod() {
        val r = WalkPlan.statusRequest(at(23, -1), at(8), ny)
        assertTrue(r.startsWith("Status update"))
        assertTrue(r.contains("every open question still waiting on me"))
        assertTrue(r.contains("even ones you asked before"))
        assertTrue(r.contains("yesterday 11:00 PM, 9 hours ago"))
    }

    @Test fun repliesFromBeforeTheClearAreNotWalkedButTheReportIs() {
        val cleared = at(8)
        assertEquals(false, WalkPlan.walkable(true, cleared - 60_000L, 0, cleared, answersStatus = false))
        assertEquals(true, WalkPlan.walkable(true, cleared - 2_000L, 0, cleared, answersStatus = true))
        assertEquals(true, WalkPlan.walkable(true, cleared + 60_000L, 0, cleared, answersStatus = false))
        assertEquals(false, WalkPlan.walkable(false, cleared + 60_000L, 0, cleared, answersStatus = true))
    }
}
