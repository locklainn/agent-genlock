package com.locklainn.genlock

import org.junit.Assert.assertEquals
import org.junit.Test

class WalkPlanTest {
    private fun item(id: String, project: String, task: String, q: Boolean = false) =
        Item(id, project, task, if (q) "question" else "update", "say $id", if (q) "ask $id?" else null)
    private fun ids(l: List<Item>) = l.map { it.id + if (it.late) "*" else "" }

    @Test fun replyIsOrderedOneProjectAtATimeQuestionsFirst() {
        val l = listOf(item("a1", "genlock", "x"), item("b1", "budget", "y"), item("a2", "genlock", "z", q = true))
        assertEquals(listOf("a2", "a1", "b1"), ids(WalkPlan.order(l)))
    }

    @Test fun sameTaskStillAheadIsReplacedInPlace() {
        val ahead = listOf(item("a1", "genlock", "x"), item("b1", "budget", "y"))
        assertEquals(listOf("a1", "b2"), ids(WalkPlan.merge(ahead, listOf(item("b2", "Budget", "Y")), emptySet())))
    }

    @Test fun sameProjectJoinsItsGroupQuestionsAheadOfUpdates() {
        val ahead = listOf(item("a1", "genlock", "x", q = true), item("a2", "genlock", "w"), item("b1", "budget", "y"))
        val m = WalkPlan.merge(ahead, listOf(item("a3", "genlock", "v"), item("a4", "genlock", "u", q = true)), emptySet())
        assertEquals(listOf("a1", "a4", "a2", "a3", "b1"), ids(m))
    }

    @Test fun alreadyHeardGoesLastMarkedLateAndNewProjectsGoAheadOfIt() {
        val heard = setOf("genlock/x")
        val m1 = WalkPlan.merge(listOf(item("b1", "budget", "y")), listOf(item("a9", "genlock", "x")), heard)
        assertEquals(listOf("b1", "a9*"), ids(m1))
        val m2 = WalkPlan.merge(m1, listOf(item("c1", "calendar", "z")), heard)
        assertEquals(listOf("b1", "c1", "a9*"), ids(m2))
        // A second late update on the same task replaces the first, still late.
        assertEquals(listOf("b1", "c1", "a10*"), ids(WalkPlan.merge(m2, listOf(item("a10", "genlock", "x")), heard)))
    }

    @Test fun itemsWithNoProjectNeverFoldIntoEachOther() {
        val m = WalkPlan.merge(listOf(item("p1", "", "")), listOf(item("p2", "", "")), emptySet())
        assertEquals(listOf("p1", "p2"), ids(m))
    }

    @Test fun onlyShortPhrasesAreCommands() {
        assertEquals(Said.Next, WalkPlan.said("Next."))
        assertEquals(Said.Repeat, WalkPlan.said("say that again"))
        assertEquals(Said.Flush, WalkPlan.said("That's it"))
        assertEquals(Said.Flush, WalkPlan.said("send"))
        assertEquals(Said.Reply("stop the build first"), WalkPlan.said("stop the build first"))
        assertEquals(Said.Reply("yes, ship it"), WalkPlan.said("yes, ship it"))
    }

    @Test fun spokenFormNamesProjectAndTask() {
        assertEquals("genlock, phone digest. Built. Ship it?",
            Item("i", "genlock", "phone digest", "question", "Built.", "Ship it?").spoken())
        assertEquals("Came in while we talked. budget. Done.", Item("j", "budget", "", "update", "Done.", late = true).spoken())
    }
}
