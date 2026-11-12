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
) {
    val isQuestion get() = kind == "question" || ask != null
    /** Same project and task means the same subject; an item with neither is only itself. */
    val key: String get() = if (project.isBlank() && task.isBlank()) "id:$id" else "${project.trim().lowercase()}/${task.trim().lowercase()}"
    val label: String get() = listOf(project, task).filter { it.isNotBlank() }.joinToString(" / ")
    /** What is read aloud. */
    fun spoken(): String = listOfNotNull(
        if (late) "Came in while we talked." else null,
        listOf(project, task).filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.joinToString(", ", postfix = "."),
        say, ask,
    ).joinToString(" ")
}

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
    private val next = setOf("next", "skip", "skip it", "next one", "move on", "pass")
    private val repeat = setOf("repeat", "repeat that", "say again", "say that again", "again", "one more time")
    private val flush = setOf("send", "send it", "send them", "send answers", "send my answers", "that's it", "thats it",
        "that's all", "thats all", "stop", "i'm done", "im done")

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
