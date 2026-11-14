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

    @Test fun itemsFromBeforeTheMovedOnMarkAreDroppedButNotTheOneBeingHeard() {
        val q = listOf(item("a", "genlock", "x").copy(at = 100), item("b", "budget", "y").copy(at = 200), item("c", "ghost", "z").copy(at = 300))
        assertEquals(listOf("c"), ids(WalkPlan.current(q, mark = 250, keepHead = false)))
        assertEquals(listOf("a", "c"), ids(WalkPlan.current(q, mark = 250, keepHead = true)))
        assertEquals(listOf("a", "b", "c"), ids(WalkPlan.current(q, mark = 0, keepHead = false)))
        assertEquals(listOf("b", "c"), ids(WalkPlan.current(q, mark = 200, keepHead = false)))
    }

    @Test fun sayingSendAtTheEndSendsTheAnswerWithoutIt() {
        assertEquals("Yes ship it", WalkPlan.spokenSend("Yes ship it send"))
        assertEquals("Use the blue one", WalkPlan.spokenSend("Use the blue one, send."))
        assertEquals("Go ahead", WalkPlan.spokenSend("Go ahead send it"))
        assertEquals("", WalkPlan.spokenSend("Send"))
        assertEquals(null, WalkPlan.spokenSend("send it to Mia first"))
        assertEquals(null, WalkPlan.spokenSend("I want the godsend"))
        assertEquals("Ship it", WalkPlan.spokenSend("Ship it, sent."))
        assertEquals("", WalkPlan.spokenSend("Cent"))
        assertEquals("It works really well", WalkPlan.spokenSend("It works really well Send send"))
        assertEquals("", WalkPlan.spokenSend("send send"))
        assertEquals(Said.Flush, WalkPlan.said("Sent."))
    }

    @Test fun theArrivalReadoutCountsUpdatesAndQuestions() {
        assertEquals("Three updates, one question.", WalkPlan.arrivalLine(4, 1))
        assertEquals("One update.", WalkPlan.arrivalLine(1, 0))
        assertEquals("Two questions.", WalkPlan.arrivalLine(2, 2))
        assertEquals("25 updates.", WalkPlan.arrivalLine(25, 0))
    }

    @Test fun linksInTheReplyGoToTheItemWhoseTaskTheirParagraphNames() {
        val a = item("t-0", "genlock", "phone digest"); val b = item("t-1", "budget", "minutes")
        val reply = "The phone digest is ready to review: [review page](https://claude.ai/code/artifact/abc).\n\nMinutes are filed, see https://example.com/m."
        assertEquals(listOf(WebLink("review page", "https://claude.ai/code/artifact/abc")), WalkPlan.linksFor(a, reply, listOf(a, b)))
        assertEquals(listOf(WebLink("example.com", "https://example.com/m")), WalkPlan.linksFor(b, reply, listOf(a, b)))
    }

    @Test fun aLinkWhoseParagraphNamesNoItemShowsOnEveryItem() {
        val a = item("t-0", "genlock", "x"); val b = item("t-1", "budget", "y")
        val reply = "Here is everything: https://claude.ai/code/artifact/z"
        assertEquals(1, WalkPlan.linksFor(a, reply, listOf(a, b)).size)
        assertEquals(1, WalkPlan.linksFor(b, reply, listOf(a, b)).size)
    }

    @Test fun aLinkInTheItemsOwnWordsShowsAndIsNotReadAloud() {
        val i = Item("t-0", "genlock", "review", "update", "The plan is up at https://claude.ai/code/artifact/q.")
        assertEquals(listOf(WebLink("claude.ai", "https://claude.ai/code/artifact/q")), WalkPlan.linksFor(i, null, listOf(i)))
        assertEquals("genlock, review. The plan is up at.", i.spoken())
        assertEquals("Open the review page now.", WalkPlan.unlinked("Open the [review page](https://x.dev/a) now."))
    }

    // YOU SAID quotes the words a reply answers, not the newest thing said (TJ, 2026-11-13).
    private val said = listOf(
        Line("ph1", Who.ME, "what is the budget doing", 1), Line("lap", Who.LAPTOP_PROMPT, "typed at the laptop", 2),
        Line("ph2", Who.ME, "nightmaremode: Yes, take turns", 3),
    )

    @Test fun aReviewSendsEachCommentTaggedWithItsImage() {
        val ims = listOf(ImageRef("r-0-img0", "a.png"), ImageRef("r-0-img1", "b.png", "the side door"), ImageRef("r-0-img2", "c.png"), ImageRef("r-0-img3", "d.png"))
        assertEquals("Image 2 of 4 (b.png, the side door): too dark\nImage 3 of 4 (c.png): love it",
            WalkPlan.reviewAnswer(ims, mapOf(1 to "too dark", 2 to " love it ", 3 to "  ")))
        assertEquals(null, WalkPlan.reviewAnswer(ims, mapOf(0 to " ")))
        val review = Item("r-0", "nightmaremode", "doors", "update", "Four options.", images = ims)
        assertEquals(true, review.isQuestion)
        assertEquals(true, review.spoken().endsWith("4 images to look at."))
    }

    @Test fun nextImageSaidAtTheEndTurnsThePageAndKeepsTheComment() {
        assertEquals("too dark" to 1, WalkPlan.spokenPage("too dark, next image."))
        assertEquals("" to 1, WalkPlan.spokenPage("Next picture"))
        assertEquals("fine" to -1, WalkPlan.spokenPage("fine previous image"))
        assertEquals(null, WalkPlan.spokenPage("the next image is better"))
    }

    @Test fun finishReviewSaidAtTheEndSendsTheWholeSet() {
        assertEquals("looks good", WalkPlan.spokenFinish("looks good, finish review."))
        assertEquals("", WalkPlan.spokenFinish("Send all"))
        assertEquals(null, WalkPlan.spokenFinish("too dark send"))
        assertEquals(null, WalkPlan.spokenFinish("we should finish review later"))
    }

    @Test fun arrivalCountsTheQueueAsItIsNowNotWhenItOpened() {
        val q = Item("a-0", "genlock", "x", "question", "s", ask = "Ship it?")
        val u = (1..5).map { Item("u-$it", "genlock", "t$it", "update", "s") }
        val opened = Arrival(6, 1, listOf("genlock"), false, 0)
        // The question was past and dropped while the screen showed: it is not announced.
        val now = WalkPlan.arrivalNow(opened, u)!!
        assertEquals(5, now.items); assertEquals(0, now.questions)
        assertEquals("Five updates.", WalkPlan.arrivalLine(now.items, now.questions))
        assertEquals(1, WalkPlan.arrivalNow(opened, u + q)!!.questions)
        assertEquals(null, WalkPlan.arrivalNow(opened, emptyList()))
    }

    @Test fun youSaidQuotesThePhoneMessageTheBridgeNames() =
        assertEquals("what is the budget doing", WalkPlan.youSaid(true, "what is the budget doing", "ph1", said))

    @Test fun youSaidIsEmptyForAReplyNobodyPrompted() =
        assertEquals(null, WalkPlan.youSaid(true, "", null, said))

    @Test fun youSaidUsesTheBridgeTextWhenThePhoneLineIsGone() =
        assertEquals("typed at the laptop", WalkPlan.youSaid(true, "typed at the laptop", "gone", said))

    @Test fun anOlderBridgeStillGetsTheNewestGuess() =
        assertEquals("nightmaremode: Yes, take turns", WalkPlan.youSaid(false, "", null, said))
}
