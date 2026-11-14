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
                   val quiet: Boolean = false)

/** TJ's answer to one item: what he said, or that he skipped it. */
data class Answer(val item: Item, val answer: String? = null, val skipped: Boolean = false)

/** What a spoken response means. Only a short phrase on its own is a command; anything longer is an answer. */
sealed class Said {
    object Next : Said()
    object Repeat : Said()
    /** Send the answers so far as one batch and end the walk; unheard items stay for next time. */
    object Flush : Said()
    data class Reply(val text: String) : Said()
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

    /** What the arrival screen says aloud, and shows: "Three updates, one question." Plain items count as updates. */
    fun arrivalLine(items: Int, questions: Int): String {
        val updates = items - questions
        return listOfNotNull(
            count(updates, "update", "updates").takeIf { updates > 0 },
            count(questions, "question", "questions").takeIf { questions > 0 },
        ).joinToString(", ").ifEmpty { "nothing new" }.replaceFirstChar { it.uppercase() } + "."
    }

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
     *  1. same task as an item still ahead: it replaces that item, in its place;
     *  2. about something already heard in this walk (or being heard now): to the very end, marked late;
     *  3. same project as items still ahead: joins that group (questions before updates);
     *  4. otherwise: at the end, ahead of any late items.
     */
    fun merge(ahead: List<Item>, incoming: List<Item>, heardKeys: Set<String>): List<Item> {
        val q = ahead.toMutableList()
        for (i in order(incoming)) {
            val same = q.indexOfFirst { it.key == i.key }
            if (same >= 0) { q[same] = i.copy(late = q[same].late); continue }
            if (i.key in heardKeys) { q.add(i.copy(late = true)); continue }
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
