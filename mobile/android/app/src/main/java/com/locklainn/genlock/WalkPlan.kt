package com.locklainn.genlock

/**
 * One thing to hear in a walk-through: what Tally said about one project's task. The bridge cuts
 * each reply into these (mobile/bridge/items.mjs). `late`: it came in about something already
 * heard in this walk, so it is read at the very end as "came in while we talked".
 */
data class Item(
    val id: String, val project: String, val task: String, val kind: String, val say: String,
    val ask: String? = null, val options: List<String> = emptyList(), val late: Boolean = false,
    /** What TJ said that this replies to, and when the reply came: kept with the item so a restart loses neither. */
    val re: String? = null, val at: Long = 0,
    /** Images an agent wants reviewed: paged through one at a time, a comment on each. */
    val images: List<ImageRef> = emptyList(),
) {
    /** A review asks for comments, so it waits for TJ like a question. */
    val isQuestion get() = kind == "question" || ask != null || images.isNotEmpty()
    /** Same project and task means the same subject; an item with neither is only itself. */
    val key: String get() = if (project.isBlank() && task.isBlank()) "id:$id" else "${project.trim().lowercase()}/${task.trim().lowercase()}"
    val label: String get() = listOf(project, task).filter { it.isNotBlank() }.joinToString(" / ")
    /** What is read aloud. A link is never read out: it is on the screen to tap. */
    fun spoken(): String = listOfNotNull(
        if (late) "Came in while we talked." else null,
        listOf(project, task).filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.joinToString(", ", postfix = "."),
        WalkPlan.unlinked(say), ask?.let { WalkPlan.unlinked(it) },
        when (images.size) { 0 -> null; 1 -> "One image to look at."; else -> "${images.size} images to look at." },
    ).joinToString(" ")
}

/** One image of a review: [fid] names the file the bridge sent with the reply; [name] its file name. */
data class ImageRef(val fid: String, val name: String, val caption: String? = null)

/** A link to open from the walk-through: what to call it, and where it goes. */
data class WebLink(val label: String, val url: String)

/** A reply has come and a walk is about to start: what the arrival screen announces. */
data class Arrival(val items: Int, val questions: Int, val projects: List<String>, val status: Boolean, val at: Long,
                   /** The speaker is off: shown without a word, and the walk waits for a tap. */
                   val quiet: Boolean = false,
                   /** A status report's lead-in, naming the period it covers: "Here's your status report from last night." */
                   val lead: String? = null,
                   /** When the oldest item is from, once it is old enough to doubt ([WalkPlan.STALE_MS]): its [Item.at]. */
                   val asOf: Long? = null)

/** TJ's answer to one item: what he said, or that he skipped it. */
data class Answer(val item: Item, val answer: String? = null, val skipped: Boolean = false)

/** What a spoken response means. Only a short phrase on its own is a command; anything longer is an answer. */
sealed class Said {
    object Next : Said()
    object Repeat : Said()
    /** Send the answers so far as one batch and end the walk; unheard items stay for next time. */
    object Flush : Said()
    data class Reply(val text: String) : Said()
    /**
     * Words that did not end in "send": not an answer yet. The walk stops and holds them in the
     * answer sheet, which keeps listening through any pause until TJ says send or taps it. A pause
     * never sends (TJ, 2026-11-14, in the car: "wait for the send word or wait for a button click,
     * not the timed-on gaps").
     */
    data class Unsent(val text: String) : Said()
}

object WalkPlan {
    private val markdownLink = Regex("""\[([^\]]+)]\((https?://[^\s)]+)\)""")
    private val bareUrl = Regex("""https?://[^\s<>()\[\]"'`]+""")

    /** Every link in [text], in order, once each: markdown links keep their label, bare ones are named by their host. */
    fun linksIn(text: String): List<WebLink> {
        val out = LinkedHashMap<String, WebLink>()
        markdownLink.findAll(text).forEach { m -> out.getOrPut(clean(m.groupValues[2])) { WebLink(m.groupValues[1].trim(), clean(m.groupValues[2])) } }
        bareUrl.findAll(markdownLink.replace(text, " ")).forEach { m -> clean(m.value).let { u -> out.getOrPut(u) { WebLink(hostOf(u), u) } } }
        return out.values.toList()
    }

    /** [text] with its links taken out for speech: a markdown link leaves its label, a bare URL leaves nothing. */
    fun unlinked(text: String): String = bareUrl.replace(markdownLink.replace(text) { it.groupValues[1] }) { it.value.substring(clean(it.value).length) }
        .replace(Regex("""\(\s*\)|:\s*(?=[.,;]|$)"""), "").replace(Regex("""\s+([.,;:!?])"""), "$1").replace(Regex("""\s{2,}"""), " ").trim()

    private fun clean(u: String) = u.trimEnd('.', ',', ';', ':', '!', '?', '*', '_')
    private fun hostOf(u: String) = u.substringAfter("://").substringBefore('/').removePrefix("www.").ifEmpty { u }

    /**
     * The links to show on [item]: those in its own words, then those in the written [reply] it came
     * from. A link in the reply goes to the item whose task (or project, for a project-wide item) its
     * paragraph names; a link whose paragraph names none of the reply's items ([siblings], this one
     * included) shows on all of them, so a link is never unreachable.
     */
    fun linksFor(item: Item, reply: String?, siblings: List<Item>): List<WebLink> {
        val own = linksIn(listOfNotNull(item.say, item.ask).joinToString("\n"))
        if (reply.isNullOrBlank()) return own
        fun names(i: Item, para: String) = (i.task.ifBlank { i.project }).takeIf { it.isNotBlank() }
            ?.let { Regex("""(?<![\p{L}\d])${Regex.escape(it.trim())}(?![\p{L}\d])""", RegexOption.IGNORE_CASE).containsMatchIn(para) } ?: false
        val fromReply = reply.split(Regex("""\n\s*\n""")).flatMap { para ->
            val links = linksIn(para)
            if (links.isEmpty()) return@flatMap emptyList()
            val named = siblings.filter { names(it, para) }
            if (named.isEmpty() || named.any { it.id == item.id }) links else emptyList()
        }
        return (own + fromReply).distinctBy { it.url }
    }
    /**
     * YOU SAID for a reply's items: the words of TJ's that the reply answers, or null when it answers
     * none of them (a relay report or an alert began the turn). The bridge names the prompt ([hasRe]):
     * [reOf] is the phone's own message that began the turn, quoted as the phone showed it; else [re],
     * the prompt as typed. Only an older bridge, which names nothing, leaves the guess: the newest
     * thing said, which quotes the wrong words for any reply TJ did not prompt.
     */
    fun youSaid(hasRe: Boolean, re: String, reOf: String?, lines: List<Line>): String? {
        val said = if (hasRe) reOf?.let { o -> lines.firstOrNull { it.id == o && it.who == Who.ME }?.text } ?: re
                   else lines.lastOrNull { it.who == Who.ME || it.who == Who.LAPTOP_PROMPT }?.text
        return said?.trim()?.takeIf { it.isNotEmpty() }
    }

    private val next = setOf("next", "skip", "skip it", "next one", "move on", "pass")
    private val repeat = setOf("repeat", "repeat that", "say again", "say that again", "again", "one more time")
    private val flush = setOf("send", "send it", "send them", "send answers", "send my answers", "that's it", "thats it",
        // What the recognizer most often writes for a lone "send": a short word said once is often misheard.
        "sent", "sent it", "sand", "cent", "scent", "sends",
        "that's all", "thats all", "stop", "i'm done", "im done")

    private val numbers = listOf("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty")
    private fun count(n: Int, one: String, many: String) = "${numbers.getOrNull(n) ?: n.toString()} ${if (n == 1) one else many}"

    /**
     * The arrival screen's counts, from the queue as it is now rather than when the screen opened:
     * items dropped meanwhile (the conversation moved on elsewhere) are not announced, so the count
     * always matches the walk that follows. Null when nothing is left to walk.
     */
    fun arrivalNow(a: Arrival, pending: List<Item>): Arrival? = if (pending.isEmpty()) null else
        a.copy(items = pending.size, questions = pending.count { it.isQuestion },
            projects = pending.map { it.project }.filter { it.isNotBlank() }.distinctBy { it.lowercase() })

    /**
     * Whether a reply at [t] is walked: the bridge did not mark it laptop-only ([walk]), the conversation
     * has not moved on past it ([movedAt]), and it did not finish before the status button cleared the
     * queue ([clearedAt]), unless it is the answer to that button ([answersStatus]).
     */
    fun walkable(walk: Boolean, t: Long, movedAt: Long, clearedAt: Long, answersStatus: Boolean): Boolean =
        walk && t >= movedAt && (answersStatus || t >= clearedAt)

    /** Items older than this are doubted: the walk says when they are from and that nothing newer came. */
    const val STALE_MS = 60 * 60 * 1000L

    /** A heading whose last two words never part: no line is left holding one word ("…status update / is in"). */
    fun keepLastTwo(s: String): String {
        val t = s.trim(); val i = t.lastIndexOf(' ')
        return if (i <= 0) t else t.substring(0, i) + '\u00A0' + t.substring(i + 1)
    }

    /** The time of [at], with the day when it is not today: "3:12 AM", "yesterday 11:40 PM", "Tue 9:05 AM". */
    fun clock(at: Long, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        val f = java.text.SimpleDateFormat("h:mm a", java.util.Locale.US).apply { timeZone = zone }
        val t = f.format(java.util.Date(at))
        return when (days(at, now, zone)) {
            0 -> t
            1 -> "yesterday $t"
            in 2..6 -> java.text.SimpleDateFormat("EEE", java.util.Locale.US).apply { timeZone = zone }.format(java.util.Date(at)) + " " + t
            else -> java.text.SimpleDateFormat("MMM d", java.util.Locale.US).apply { timeZone = zone }.format(java.util.Date(at)) + " " + t
        }
    }

    /** Calendar days from [a] to [b] in [zone]. */
    private fun days(a: Long, b: Long, zone: java.util.TimeZone): Int {
        fun day(t: Long) = (t + zone.getOffset(t)) / 86_400_000L
        return (day(b) - day(a)).toInt()
    }

    /** "45 minutes ago", "7 hours ago", "2 days ago". */
    fun ago(at: Long, now: Long): String {
        val m = ((now - at) / 60_000L).coerceAtLeast(0)
        return when {
            m < 1 -> "just now"
            m < 60 -> "$m minute${if (m == 1L) "" else "s"} ago"
            m < 48 * 60 -> (m / 60).let { h -> "$h hour${if (h == 1L) "" else "s"} ago" }
            else -> (m / 1440).let { d -> "$d days ago" }
        }
    }

    /** "As of 3:12 AM, 7 hours ago" when [at] is older than [STALE_MS]; null while it is fresh. */
    fun asOf(at: Long, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String? =
        if (at <= 0 || now - at < STALE_MS) null else "As of ${clock(at, now, zone)}, ${ago(at, now)}"

    /** The oldest item's time when the queue is old enough to doubt; null when every item is fresh. */
    fun staleSince(items: List<Item>, now: Long): Long? =
        items.map { it.at }.filter { it > 0 }.minOrNull()?.takeIf { now - it >= STALE_MS }

    /**
     * The period a status report covers, from when TJ last heard an update ([since]) to [now], as a
     * listener would say it: "from last night", "from this morning", "from the last 3 hours".
     */
    fun period(since: Long, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String? {
        if (since <= 0 || now <= since) return null
        val gap = now - since
        val cal = { t: Long -> java.util.Calendar.getInstance(zone).apply { timeInMillis = t }.get(java.util.Calendar.HOUR_OF_DAY) }
        val (sh, nh, d) = Triple(cal(since), cal(now), days(since, now, zone))
        val mins = gap / 60_000L
        return when {
            mins < 90 -> if (mins < 50) "from the last ${mins.coerceAtLeast(1)} minute${if (mins <= 1) "" else "s"}" else "from the last hour"
            d == 1 && nh < 13 && (sh >= 17 || gap <= 16 * 3_600_000L) -> "from last night"
            d == 0 && sh < 6 && nh < 13 -> "from overnight"
            d == 0 && sh < 12 && nh >= 12 -> "from this morning"
            d == 0 -> (mins / 60).let { h -> "from the last $h hours" }
            d == 1 -> "since yesterday"
            else -> "from the last $d days"
        }
    }

    /** What a status report opens with, said and shown: "Here's your status report from last night." */
    fun lead(since: Long, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String =
        "Here's your status report" + (period(since, now, zone)?.let { " $it" } ?: "") + "."

    /**
     * What the status button asks for: a full, fresh report that stands on its own, since the phone
     * has just thrown away everything it held. It names the period, and asks for every open question
     * again, so nothing waiting on TJ is lost with the queue. Starts "Status update" (the arrival screen keys on it).
     */
    fun statusRequest(since: Long, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String =
        "Status update, a fresh full report: I cleared everything queued on the phone, so treat this as if you had told me nothing. " +
        "Every project, each time: where it stands now" +
        (if (since > 0) ", and what happened since I last heard an update (${clock(since, now, zone)}, ${ago(since, now)})" else "") +
        ". Then list every open question still waiting on me, from every project, even ones you asked before, each as its own question item. " +
        "Only the latest state of each thing; say no change for a project that has none."

    /** What the arrival screen says aloud, and shows: "Three updates, one question." Plain items count as updates. */
    fun arrivalLine(items: Int, questions: Int): String {
        val updates = items - questions
        return listOfNotNull(
            count(updates, "update", "updates").takeIf { updates > 0 },
            count(questions, "question", "questions").takeIf { questions > 0 },
        ).joinToString(", ").ifEmpty { "nothing new" }.replaceFirstChar { it.uppercase() } + "."
    }

    /**
     * The whole arrival readout: the status lead-in, the counts, and for items old enough to doubt,
     * when they are from and whether anything newer could have come ([connected]: the laptop just
     * replayed everything the phone missed, so nothing newer has).
     */
    fun arrivalSpoken(a: Arrival, now: Long, connected: Boolean): String = listOfNotNull(
        a.lead, arrivalLine(a.items, a.questions), a.asOf?.let { freshness(it, now, connected) },
    ).joinToString(" ")

    /** "These are from 7 hours ago, and nothing newer has come in." */
    fun freshness(asOf: Long, now: Long, connected: Boolean): String =
        "These are from ${ago(asOf, now)}" +
        if (connected) ", and nothing newer has come in." else ". Not connected to the laptop, so there may be newer news."

    /** "send", plus the words a recognizer writes for it when it is said alone and short (TJ: "I have to say send like 12 times"). */
    /** How a review comment names its image: "Image 2 of 4 (door.png, the side door)". */
    fun imageLabel(images: List<ImageRef>, n: Int): String {
        val im = images[n]
        val about = listOfNotNull(im.name.ifBlank { null }, im.caption?.takeIf { it.isNotBlank() }).joinToString(", ")
        return "Image ${n + 1} of ${images.size}" + if (about.isNotEmpty()) " ($about)" else ""
    }

    /**
     * A review's answer: each comment on its own line, tagged with the image it is about, so the
     * session that asked can tell which image each one means. Null when nothing was said on any.
     */
    fun reviewAnswer(images: List<ImageRef>, comments: Map<Int, String>): String? =
        images.indices.mapNotNull { n -> comments[n]?.trim()?.takeIf { it.isNotEmpty() }?.let { "${imageLabel(images, n)}: $it" } }
            .takeIf { it.isNotEmpty() }?.joinToString("\n")

    private val pageWords = listOf("next image" to 1, "next picture" to 1, "next photo" to 1,
        "previous image" to -1, "previous picture" to -1, "previous photo" to -1, "last image" to -1)

    /**
     * Paging a review by voice: dictation ending "next image" (or "previous image") returns the
     * comment without those words and which way to turn; null when it does not end that way.
     */
    fun spokenPage(text: String): Pair<String, Int>? {
        val t = text.trim().trimEnd('.', '!', ',', '?', ' ')
        val low = t.lowercase()
        for ((w, d) in pageWords) {
            if (low == w) return "" to d
            if (low.endsWith(" $w")) return t.dropLast(w.length).trim().trimEnd(',', '.', ' ') to d
        }
        return null
    }

    private val finishWords = listOf("finish review", "finish the review", "finish reviewing", "send all", "send them all", "send all of them", "done reviewing")

    /** A review's finish step said aloud: the comment without those words, or null when it does not end that way. */
    fun spokenFinish(text: String): String? {
        val t = text.trim().trimEnd('.', '!', ',', '?', ' ')
        val low = t.lowercase()
        for (w in finishWords) {
            if (low == w) return ""
            if (low.endsWith(" $w")) return t.dropLast(w.length).trim().trimEnd(',', '.', ' ')
        }
        return null
    }

    private val sendWords = listOf("send it", "send that", "sent it", "send", "sent", "sand", "cent", "scent", "sends")

    /**
     * An answer dictated in the answer sheet ends when TJ says "send" as the last word: returns the
     * answer without it, or null when it does not end that way ("send it to Mia" does not end it).
     * Empty when "send" was all he said.
     */
    fun spokenSend(text: String): String? {
        val t = text.trim().trimEnd('.', '!', ',', '?', ' ')
        val low = t.lowercase()
        for (w in sendWords) {
            if (low == w) return ""
            // "send send" (said twice to be sure): every trailing send goes, not just the last.
            if (low.endsWith(" $w")) { val rest = t.dropLast(w.length).trim().trimEnd(',', '.', ' '); return spokenSend(rest) ?: rest }
        }
        return null
    }

    fun said(heard: String): Said {
        val t = heard.lowercase().replace(Regex("[^a-z' ]"), " ").replace(Regex("\\s+"), " ").trim()
        return when {
            t.isEmpty() -> Said.Next
            t in next -> Said.Next
            t in repeat -> Said.Repeat
            t in flush -> Said.Flush
            else -> Said.Reply(heard.trim())
        }
    }

    /**
     * What words heard after an item mean, when the recognizer stopped on a pause. Commands stand
     * as they are. Anything else is an answer only if it ends in "send" (then that word goes);
     * otherwise it is [Said.Unsent], held for TJ to finish.
     */
    /**
     * Go back to step [to] of the walk (0 is the first): it and every step heard after it return to
     * the front of the queue, in order, ahead of what was still to come. TJ, 2026-11-14: "if I click
     * a step it should go back, but I should have a way to restart the update from the beginning".
     * Returns (walked, pending).
     */
    fun rewind(walked: List<Item>, pending: List<Item>, to: Int): Pair<List<Item>, List<Item>> {
        val k = to.coerceIn(0, walked.size)
        val back = walked.drop(k)
        return walked.take(k) to (back + pending.filterNot { p -> back.any { it.id == p.id } })
    }

    fun saidOnPause(heard: String): Said = when (val s = said(heard)) {
        is Said.Reply -> spokenSend(s.text)?.let { if (it.isBlank()) Said.Flush else Said.Reply(it) } ?: Said.Unsent(s.text)
        else -> s
    }

    /**
     * The items still worth hearing once TJ has moved on away from the phone at [mark] (ms, laptop
     * clock): only those that came in at or after it. The one being heard right now ([keepHead]) is
     * not cut off mid-sentence.
     */
    fun current(items: List<Item>, mark: Long, keepHead: Boolean): List<Item> =
        if (mark <= 0) items else items.filterIndexed { i, it -> (keepHead && i == 0) || it.at >= mark }

    /**
     * A reply's items in the order to walk them: one project at a time, in the order they first
     * appear, with that project's questions ahead of its plain updates.
     */
    fun order(items: List<Item>): List<Item> {
        val projects = items.map { it.project.lowercase() }.distinct()
        return projects.flatMap { p -> items.filter { it.project.lowercase() == p }.sortedBy { if (it.isQuestion) 0 else 1 } }
    }

    /**
     * Merges newly arrived items into the queue still ahead, without interrupting anything (TJ's
     * placement rule, agreed 2026-11-12):
     *  0. a plain update replaces older plain updates still ahead for its project (one current word per project);
     *  1. same task as an item still ahead: it replaces that item, in its place;
     *  2. about something already heard in this walk (or being heard now): to the very end, marked late;
     *  3. same project as items still ahead: joins that group (questions before updates);
     *  4. otherwise: at the end, ahead of any late items.
     */
    fun merge(ahead: List<Item>, incoming: List<Item>, heardKeys: Set<String>): List<Item> {
        val q = ahead.toMutableList()
        for (i in order(incoming)) {
            // A newer plain update for a project replaces that project's older plain updates: one current word per
            // project, never an old one walked ahead of the new. Questions go only when their own task is replaced.
            // It takes the place of the first one it replaces.
            val older = { o: Item -> !i.isQuestion && i.project.isNotBlank() && !o.isQuestion && o.key != i.key && o.at < i.at &&
                o.project.equals(i.project, ignoreCase = true) }
            val slot = q.indexOfFirst(older)
            val slotLate = slot >= 0 && q[slot].late
            q.removeAll(older)
            val same = q.indexOfFirst { it.key == i.key }
            if (same >= 0) { q[same] = i.copy(late = q[same].late); continue }
            if (i.key in heardKeys) { q.add(i.copy(late = true)); continue }
            if (slot >= 0) { q.add(slot.coerceAtMost(q.size), i.copy(late = slotLate)); continue }
            val firstLate = q.indexOfFirst { it.late }.let { if (it < 0) q.size else it }
            val group = (0 until firstLate).filter { q[it].project.equals(i.project, ignoreCase = true) && i.project.isNotBlank() }
            val at = when {
                group.isEmpty() -> firstLate
                i.isQuestion -> (group.lastOrNull { q[it].isQuestion }?.plus(1)) ?: group.first()
                else -> group.last() + 1
            }
            q.add(at, i)
        }
        return q
    }
}
