package com.locklainn.genlock

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

internal val INK = Color(0xFF0F0F12)
internal val QUESTION = Color(0xFFF2B84B)
private val DONE = Color(0xFF7BD88F)
private val BLOCKED = Color(0xFFFF6B6B)

/** A colour per project, so the screen says which project it is before you read a word. */
private val HUES = listOf(
    Color(0xFF5B3FD9), Color(0xFF1E7A6B), Color(0xFFB0413E), Color(0xFF2F6BD1),
    Color(0xFF8A3FA6), Color(0xFFB8721D), Color(0xFF2E8540), Color(0xFF9C2F6B),
)
private fun projectColor(name: String) = HUES[Math.floorMod(name.lowercase().hashCode(), HUES.size)]

/**
 * The digest: a walk-through as a now-playing screen. It fills everything above the input bar.
 * Top to bottom: a segmented progress bar (one segment per item: heard, now, ahead, questions in
 * amber), the project and the task in big type, the open question set apart, what is up next, the
 * transport (repeat, pause/play, next) with Send, and at the bottom the running caption: the words
 * being read, lit up as the voice reaches them, or what the mic is hearing.
 */
@Composable
fun FocusView(link: Link, walker: Walker, modifier: Modifier = Modifier) {
    val pending by link.pending.collectAsStateWithLifecycle()
    val walked by link.walked.collectAsStateWithLifecycle()
    val held by link.held.collectAsStateWithLifecycle()
    val active by walker.active.collectAsStateWithLifecycle()
    val phase by walker.phase.collectAsStateWithLifecycle()
    val hearing by walker.hearing.collectAsStateWithLifecycle()
    val spoken by walker.spoken.collectAsStateWithLifecycle()
    val spokenTo by walker.spokenTo.collectAsStateWithLifecycle()
    val sentence by walker.sentence.collectAsStateWithLifecycle()
    val waiting by link.waiting.collectAsStateWithLifecycle()
    val name by link.assistantName.collectAsStateWithLifecycle()
    val lines by link.lines.collectAsStateWithLifecycle()
    val answered = held.count { it.answer != null }

    val now = pending.firstOrNull()
    val accent by animateColorAsState(projectColor(now?.project?.ifBlank { name } ?: name), tween(600), label = "accent")

    Column(
        modifier.fillMaxWidth()
            .background(Brush.verticalGradient(0f to accent, 0.55f to accent.copy(alpha = 0.35f).compositeOver(INK), 1f to INK))
            .padding(horizontal = 22.dp, vertical = 14.dp),
    ) {
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            // Your latest message, until its reply is here: where it is, so you never wonder whether it arrived.
            val mine = lines.indexOfLast { it.who == Who.ME }
            val outgoing = lines.getOrNull(mine)?.takeIf { l -> lines.drop(mine + 1).none { it.who == Who.ASSISTANT } && (waiting || l.failed) }
            if (now == null) {
                // "All caught up" says its piece for a few seconds, then gives the screen to what is going on.
                val idle = outgoing == null && answered == 0
                var settled by remember { mutableStateOf(false) }
                LaunchedEffect(idle) { settled = false; if (idle) { kotlinx.coroutines.delay(CAUGHT_UP_MS); settled = true } }
                val grid by link.grid.collectAsStateWithLifecycle()
                if (idle && settled) AtWork(grid)
                else CaughtUp(name, outgoing?.stage, answered, walked.size, { walker.flush() }, { outgoing?.let { link.retry(it) } })
                return@CompositionLocalProvider
            }

            Segments(walked, pending, active)
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("DIGEST  ·  ${walked.size + 1} OF ${walked.size + pending.size}", style = MaterialTheme.typography.labelMedium,
                    letterSpacing = 1.6.sp, color = Color.White.copy(alpha = 0.7f), modifier = Modifier.weight(1f))
                if (answered > 0) FilledTonalButton(onClick = { walker.flush() }, contentPadding = PaddingValues(horizontal = 14.dp),
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = Color.White.copy(alpha = 0.18f), contentColor = Color.White)) {
                    Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Send $answered")
                }
            }

            // The middle scrolls if a long question needs it; the controls and caption never move.
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                Spacer(Modifier.height(18.dp))
                // Context, never a sentence: project over task; with no tags, the assistant and when it replied.
                val untitled = now.task.isBlank()
                val sent = now.at.takeIf { it > 0 } ?: lines.lastOrNull { it.who == Who.ASSISTANT && now.id.startsWith(it.id + "-") }?.t
                val kicker = if (untitled) listOfNotNull(now.project.ifBlank { null } ?: "REPLY", sent?.let { clock(it) }).joinToString("  ·  ") else now.project.ifBlank { name }
                Text(kicker.uppercase(), style = MaterialTheme.typography.titleSmall, letterSpacing = 2.sp,
                    fontWeight = FontWeight.Bold, color = Color.White.copy(alpha = 0.75f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(4.dp))
                Text(if (untitled) name else now.task, fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold, maxLines = 4, overflow = TextOverflow.Ellipsis)
                // What this is answering: your own words, quoted, so a "Yes," has something to attach to.
                now.re?.let { re ->
                    Spacer(Modifier.height(12.dp))
                    Row(Modifier.height(IntrinsicSize.Min)) {
                        Box(Modifier.width(3.dp).fillMaxHeight().clip(CircleShape).background(Color.White.copy(alpha = 0.4f)))
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text("YOU SAID", style = MaterialTheme.typography.labelSmall, letterSpacing = 1.4.sp, color = Color.White.copy(alpha = 0.6f))
                            Text(re, style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.85f), maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                KindTag(now)
                // Links to open: in the item's own words, or in the written reply where its paragraph names this task.
                val reply = lines.lastOrNull { it.who == Who.ASSISTANT && now.id.startsWith(it.id + "-") }
                val links = remember(now.id, reply?.text) {
                    val siblings = reply?.let { r -> (walked + pending).filter { it.id.startsWith(r.id + "-") } } ?: listOf(now)
                    WalkPlan.linksFor(now, reply?.text, siblings)
                }
                if (links.isNotEmpty()) { Spacer(Modifier.height(14.dp)); Links(links) }
                if (now.late) Text("Came in while we talked", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = 0.7f))
                // The question itself is not here: it opens in the answer sheet once the item has been read.
                // One quiet line, so nothing competes with the headline: the next title, or just a count.
                val next = pending.drop(1)
                if (next.isNotEmpty()) {
                    Spacer(Modifier.height(22.dp))
                    UpNext(next.first(), next.size - 1) { walker.jumpTo(next.first()) }
                }
            }

            CountdownBar(walker, Color.White, Color.White.copy(alpha = 0.2f), Modifier.fillMaxWidth().padding(bottom = 6.dp))
            Transport(active, onPlay = { if (active) walker.pause() else walker.start() }, onRepeat = { if (active) walker.repeat() else walker.start() }, onNext = { walker.next() })
            Spacer(Modifier.height(10.dp))
            // The caption carries the body only; the headline is already up top in big type.
            val body = now.say.replace(Regex("[*`#_]"), "")
            val read = spoken.ifBlank { now.spoken() }
            val at = read.indexOf(body).takeIf { it >= 0 && body.isNotEmpty() }
            // In the Genlock voice the caption is the sentence playing, whole; in the built-in voice it follows word by word.
            if (sentence.isNotBlank()) Caption(active, phase, sentence, sentence.length, hearing)
            else Caption(active, phase, body, at?.let { spokenTo - it } ?: 0, hearing)
        }
    }
}

/** One segment per item in the walk, like story progress: heard full, now bright, questions amber. */
@Composable
private fun Segments(walked: List<Item>, pending: List<Item>, active: Boolean) {
    Row(Modifier.fillMaxWidth().height(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        walked.forEach { Box(Modifier.weight(1f).fillMaxHeight().clip(CircleShape).background(Color.White.copy(alpha = 0.85f))) }
        pending.forEachIndexed { n, i ->
            val c = when {
                n == 0 -> if (i.isQuestion) QUESTION else Color.White
                i.isQuestion -> QUESTION.copy(alpha = 0.45f)
                else -> Color.White.copy(alpha = 0.25f)
            }
            Box(Modifier.weight(1f).fillMaxHeight().clip(CircleShape).background(if (n == 0 && !active) c.copy(alpha = 0.6f) else c))
        }
    }
}

@Composable
private fun KindTag(i: Item) {
    // A plain update needs no tag: the absence is the signal, and the tags that show stay loud.
    val (label, color) = when {
        i.isQuestion -> "QUESTION" to QUESTION
        i.kind == "blocked" -> "BLOCKED" to BLOCKED
        i.kind == "done" -> "DONE" to DONE
        else -> return
    }
    Text(label, Modifier.clip(RoundedCornerShape(6.dp)).background(color.copy(alpha = 0.2f)).padding(horizontal = 8.dp, vertical = 3.dp),
        style = MaterialTheme.typography.labelSmall, letterSpacing = 1.4.sp, fontWeight = FontWeight.Bold, color = color)
}

/** Each link as a pill to tap: it opens in the browser, and the walk keeps its place. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Links(links: List<WebLink>) {
    val open = LocalUriHandler.current
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        links.forEach { l ->
            Row(Modifier.clip(RoundedCornerShape(22.dp)).background(Color.White.copy(alpha = 0.16f))
                .clickable { runCatching { open.openUri(l.url) } }.heightIn(min = 44.dp).padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Link, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(l.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.width(6.dp))
                Icon(Icons.AutoMirrored.Filled.OpenInNew, "Open", Modifier.size(14.dp), tint = Color.White.copy(alpha = 0.7f))
            }
        }
    }
}

@Composable
private fun UpNext(i: Item, more: Int, onTap: () -> Unit) {
    val dim = Color.White.copy(alpha = 0.6f)
    val title = i.task.takeIf { it.isNotBlank() }?.let { t -> listOf(i.project, t).filter { it.isNotBlank() }.joinToString(" · ") }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(enabled = title != null, onClick = onTap).heightIn(min = 44.dp).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text("NEXT", style = MaterialTheme.typography.labelSmall, letterSpacing = 1.6.sp, color = dim)
        Spacer(Modifier.width(10.dp))
        if (title != null) {
            if (i.isQuestion) { Box(Modifier.size(7.dp).clip(CircleShape).background(QUESTION)); Spacer(Modifier.width(6.dp)) }
            Text(title, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium, color = dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (more > 0) Text("  +$more", style = MaterialTheme.typography.bodyMedium, color = dim)
        } else {
            Text("${more + 1} more after this", style = MaterialTheme.typography.bodyMedium, color = dim)
        }
    }
}

/** Repeat · big pause/play · next. Pause stops the voice at once and keeps your place. */
@Composable
private fun Transport(active: Boolean, onPlay: () -> Unit, onRepeat: () -> Unit, onNext: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onRepeat, Modifier.size(56.dp)) { Icon(Icons.Default.Replay, "Repeat", Modifier.size(30.dp)) }
        FilledIconButton(onClick = onPlay, Modifier.size(76.dp),
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = Color.White, contentColor = INK)) {
            Icon(if (active) Icons.Default.Pause else Icons.Default.PlayArrow, if (active) "Pause" else "Play", Modifier.size(42.dp))
        }
        IconButton(onClick = onNext, Modifier.size(56.dp), enabled = active) {
            Icon(Icons.Default.SkipNext, "Next", Modifier.size(34.dp), tint = if (active) Color.White else Color.White.copy(alpha = 0.35f))
        }
    }
}

/** The running caption: words already read in white, the rest dim, like lyrics; or what the mic hears. */
@Composable
private fun Caption(active: Boolean, phase: Walker.Phase, text: String, to: Int, hearing: String) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color.White.copy(alpha = 0.10f)).padding(14.dp)) {
        val listening = active && phase == Walker.Phase.LISTENING
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (listening) Icons.Default.Mic else Icons.Default.GraphicEq, null, Modifier.size(16.dp),
                tint = if (listening) QUESTION else Color.White.copy(alpha = 0.7f))
            Spacer(Modifier.width(6.dp))
            Text(when { !active -> "PAUSED"; listening -> "LISTENING"; else -> "READING" }, style = MaterialTheme.typography.labelSmall,
                letterSpacing = 1.4.sp, color = Color.White.copy(alpha = 0.7f))
        }
        Spacer(Modifier.height(6.dp))
        if (listening) {
            Text(hearing.ifBlank { "Answer, or say next, repeat or send" }, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold,
                color = if (hearing.isBlank()) Color.White.copy(alpha = 0.55f) else Color.White, maxLines = 3, overflow = TextOverflow.Ellipsis)
        } else {
            // Like live subtitles: a word appears only once it has been said, never ahead of the voice.
            val said = text.substring(0, to.coerceIn(0, text.length)).trim()
            val tail = if (said.length > 220) "…" + said.takeLast(220).substringAfter(' ') else said
            Text(tail.ifEmpty { if (active) "" else "Tap play to hear it" }, fontSize = 18.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold,
                color = if (tail.isEmpty()) Color.White.copy(alpha = 0.55f) else Color.White, maxLines = 4, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.heightIn(min = 25.dp))
        }
    }
}

/** How long "All caught up" shows before the screen turns to the sessions at work. */
private const val CAUGHT_UP_MS = 5_000L

/**
 * Nothing to hear: the sessions at work, as a sign that things are going on. Working and paused are
 * counted the way genlock sweep counts them, from each session's reported phase: "working" is
 * working now, "holding" (its turn is over but a job it started still runs) is paused.
 */
@Composable
private fun ColumnScope.AtWork(grid: Grid?) {
    val rows = grid?.projects.orEmpty().flatMap { p -> p.sessions.filter { it.running }.map { p to it } }
    val working = rows.filter { it.second.phase == "working" }
    val paused = rows.filter { it.second.phase == "holding" }
    val pulse by androidx.compose.animation.core.rememberInfiniteTransition(label = "atwork").animateFloat(0.35f, 1f,
        androidx.compose.animation.core.infiniteRepeatable(tween(900), androidx.compose.animation.core.RepeatMode.Reverse), label = "dot")
    Spacer(Modifier.height(24.dp))
    Text("AT WORK NOW", style = MaterialTheme.typography.titleSmall, letterSpacing = 2.sp, fontWeight = FontWeight.Bold, color = Color.White.copy(alpha = 0.75f))
    Spacer(Modifier.height(10.dp))
    if (grid == null || grid.mac != "open") {
        Text(if (grid == null) "Waiting for the Mac…" else "The Mac app is closed", fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.ExtraBold)
        Spacer(Modifier.weight(1f)); return
    }
    // The same big bold title every update has, so this screen reads like the rest of the walk.
    Text(when {
        working.isNotEmpty() -> "${working.size} ${if (working.size == 1) "session" else "sessions"} working"
        paused.isNotEmpty() -> "All paused"
        else -> "Nothing running"
    }, fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
    Spacer(Modifier.height(8.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(if (working.isEmpty()) Color.White.copy(alpha = 0.3f) else DONE.copy(alpha = pulse)))
        Spacer(Modifier.width(8.dp))
        Text(if (working.isEmpty()) "Quiet" else "Active", style = MaterialTheme.typography.titleMedium, color = if (working.isEmpty()) Color.White.copy(alpha = 0.6f) else DONE)
        if (paused.isNotEmpty()) {
            Text("  ·  ", style = MaterialTheme.typography.titleMedium, color = Color.White.copy(alpha = 0.5f))
            Text("${paused.size} paused", style = MaterialTheme.typography.titleMedium, color = QUESTION)
        }
    }
    Spacer(Modifier.height(18.dp))
    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        (working.map { it to true } + paused.map { it to false }).forEach { (ps, active) ->
            val (p, x) = ps
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (active) Box(Modifier.size(9.dp).clip(CircleShape).background(DONE.copy(alpha = pulse)))
                else Icon(Icons.Default.Pause, "Paused", Modifier.size(14.dp), tint = QUESTION)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(listOf(p.name, x.title).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val line = x.wait?.headline?.takeIf { it.isNotBlank() } ?: x.task ?: x.headline
                    if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.65f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(if (active) "working" else "paused", style = MaterialTheme.typography.labelMedium, color = if (active) DONE else QUESTION)
            }
        }
        if (rows.isNotEmpty() && working.isEmpty() && paused.isEmpty()) Text("Nothing running right now. Say or type anything to start something.",
            style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.7f))
    }
}

/** Nothing left to walk. [stage]: where your latest message is, while its reply has not come. */
@Composable
private fun ColumnScope.CaughtUp(name: String, stage: Stage?, answered: Int, heard: Int, send: () -> Unit, retry: () -> Unit) {
    Spacer(Modifier.weight(1f))
    Text(when (stage) {
        Stage.SENDING -> "Sending…"
        Stage.DELIVERED -> "Delivered"
        Stage.PICKED -> "$name is working…"
        Stage.FAILED -> "Not delivered"
        null -> "All caught up"
    }, fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold)
    Spacer(Modifier.height(8.dp))
    Text(when {
        stage == Stage.SENDING -> "Sending your message…"
        stage == Stage.DELIVERED -> "Delivered. $name has not started on it yet."
        stage == Stage.PICKED -> "$name has your message. The reply plays here when it is ready."
        stage == Stage.FAILED -> "Your message did not get through. It is kept: tap Retry to send it again."
        heard > 0 -> "You heard $heard item${if (heard == 1) "" else "s"}. Say or type anything to start something new."
        else -> "Say or type anything. Replies play here, one item at a time."
    }, style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.75f))
    if (stage == Stage.SENDING || stage == Stage.DELIVERED || stage == Stage.PICKED) {
        Spacer(Modifier.height(16.dp))
        LinearProgressIndicator(Modifier.fillMaxWidth(), color = Color.White, trackColor = Color.White.copy(alpha = 0.2f))
    }
    if (stage == Stage.FAILED) {
        Spacer(Modifier.height(18.dp))
        Button(onClick = retry, colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = INK)) { Text("Retry") }
    }
    if (answered > 0) {
        Spacer(Modifier.height(18.dp))
        Button(onClick = send, colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = INK)) { Text("Send $answered answer${if (answered == 1) "" else "s"}") }
    }
    Spacer(Modifier.weight(1f))
}

private fun Color.compositeOver(bg: Color): Color {
    val a = alpha
    return Color(red * a + bg.red * (1 - a), green * a + bg.green * (1 - a), blue * a + bg.blue * (1 - a), 1f)
}

private fun clock(t: Long): String = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(t))
