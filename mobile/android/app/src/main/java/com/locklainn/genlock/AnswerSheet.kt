package com.locklainn.genlock

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.focus.onFocusChanged
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The answer sheet: an item's question, full screen, opened only once the item has been read out.
 * Three ways to answer: a suggested answer, typing, or saying it. The mic works like the main one:
 * it is on when the sheet opens, keeps listening through pauses, and nothing goes until TJ taps
 * send (what it hears lands in the box, to read and fix). Hear again, Skip, and close (which pauses
 * the walk with the question still first).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AnswerSheet(walker: Walker) {
    val item by walker.asking.collectAsStateWithLifecycle()
    val i = item ?: return
    val ctx = LocalContext.current
    var typed by remember(i.id) { mutableStateOf("") }
    var listening by remember(i.id) { mutableStateOf(false) }
    var finishing by remember(i.id) { mutableStateOf(false) }
    var problem by remember(i.id) { mutableStateOf<String?>(null) }
    /**
     * An answer TJ ended by saying "send", waiting out [SEND_CONFIRM_MS] before it goes. Any further
     * word, a tap on the box, or Cancel disarms it. Silence never sends anything: only this does.
     */
    var armed by remember(i.id) { mutableStateOf<Armed?>(null) }
    val spokenSend = remember(i.id) { SpokenSend() }
    val granted = { ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
    // A review: one comment per image, the box holding the one on screen.
    val images = i.images
    var page by remember(i.id) { mutableIntStateOf(0) }
    val comments = remember(i.id) { mutableStateMapOf<Int, String>() }
    /** The answer to send, given the words in the box now: for a review, every image's comment, each tagged. */
    fun finalText(current: String): String? =
        if (images.isEmpty()) current.trim().takeIf { it.isNotEmpty() }
        else WalkPlan.reviewAnswer(images, comments.toMap() + (page to current))
    var turnTo: (Int) -> Unit = {}
    val lastSettled = remember(i.id) { arrayOf("") }
    val dictation = remember(i.id) {
        Dictation(ctx,
            onText = { settled, partial ->
                val all = listOf(settled, partial).filter { it.isNotBlank() }.joinToString(" ")
                android.util.Log.i("GenlockSend", "heard settled=\"$settled\" partial=\"$partial\"")
                // Each settled phrase goes to the bridge log too, so a missed "send" shows what was heard instead.
                if (settled.isNotBlank() && settled != lastSettled[0]) { lastSettled[0] = settled; walker.diag("sheet heard: \"${settled.takeLast(60)}\"") }
                // "next image": the words so far stay with this image, and the next one comes up.
                if (images.isNotEmpty()) WalkPlan.spokenPage(all)?.let { (rest, d) -> typed = rest; turnTo(page + d); return@Dictation }
                // "finish review": every comment goes now, wherever in the set TJ is.
                if (images.isNotEmpty() && armed?.finish != true) WalkPlan.spokenFinish(all)?.let { rest -> typed = rest; armed = Armed(rest, finish = true); return@Dictation }
                if (armed?.finish == true && WalkPlan.spokenFinish(all) == armed?.text) return@Dictation
                // Armed, and the recognizer only settled the same words: leave the box as it is (no "send").
                if (armed != null && WalkPlan.spokenSend(all) == armed?.text) return@Dictation
                typed = all
                spokenSend.heard(all, System.currentTimeMillis())
                if (armed != null) { android.util.Log.i("GenlockSend", "disarmed: more words"); armed = null }
            },
            onListening = { on ->
                listening = on
                if (on) { Cues.listening(); AudioHold.take(ctx, AudioHold.MIC) } else AudioHold.drop(AudioHold.MIC)
            },
            onProblem = { problem = it })
    }
    // Every way of answering ends here, typed, tapped or spoken: the same Answer(item, text) for this step.
    fun answer(text: String, via: String = "typed") {
        android.util.Log.i("GenlockSend", "answer via=$via item=${i.id} project=${i.project} task=${i.task}: \"$text\"")
        dictation.destroy(); Cues.answered(); walker.answer(text)
    }
    // "send" has stood as the last word for SpokenSend.QUIET_MS, mic on: start the visible countdown.
    // Silence alone never sends: it only lets a "send" that was said stand.
    LaunchedEffect(i.id) {
        while (true) {
            kotlinx.coroutines.delay(200)
            // Not gated on the mic still being on: the recognizer often closes the moment "send" is
            // said, and a send that waits for an open mic never arms (the "say it 12 times" bug).
            if (armed != null) continue
            spokenSend.ready(System.currentTimeMillis())?.let { answer ->
                // A review before its last image: keeping a comment and turning the page loses
                // nothing, so it happens at once, with no countdown bar appearing to move the layout.
                if (images.isNotEmpty() && page < images.size - 1) {
                    walker.diag("spoken send: comment kept, next image")
                    typed = answer; spokenSend.reset(); turnTo(page + 1)
                    if (!dictation.listening && granted()) dictation.start(typed)
                    return@let
                }
                android.util.Log.i("GenlockSend", "armed: \"$answer\"")
                walker.diag("spoken send armed${if (answer.isBlank()) " (send alone)" else ""} after: \"${spokenSend.lastHeard.takeLast(60)}\"")
                typed = answer
                armed = Armed(answer)
            }
        }
    }
    LaunchedEffect(armed) {
        val a = armed ?: return@LaunchedEffect
        kotlinx.coroutines.delay(SEND_CONFIRM_MS)
        if (armed !== a) return@LaunchedEffect
        walker.diag("spoken send: ${when {
            a.finish -> "finish review"
            images.isNotEmpty() && page < images.size - 1 -> "comment kept, next image"
            a.text.isBlank() -> "on its own, sending the answers so far"
            else -> "answer sent"
        }}")
        // A review: "send" on an image before the last keeps its comment and turns to the next one
        // (TJ: send on image 2 "cleared all four images, that's not what I expected"). Only the last
        // image's send, or "finish review", sends the set.
        if (images.isNotEmpty() && !a.finish && page < images.size - 1) {
            typed = a.text; armed = null; spokenSend.reset(); turnTo(page + 1)
            if (!dictation.listening && granted()) dictation.start(typed)
            return@LaunchedEffect
        }
        val review = if (images.isNotEmpty()) finalText(a.text) else null
        // "send" on its own: the answers so far go, and this question stays for next time.
        when {
            review != null -> answer(review, via = "spoken send, review")
            a.text.isBlank() -> { dictation.destroy(); Cues.answered(); walker.flush() }
            else -> answer(a.text, via = "spoken send")
        }
    }
    DisposableEffect(i.id) { onDispose { dictation.destroy(); AudioHold.drop(AudioHold.MIC) } }
    /** Disarm, and carry on listening from the text as it stands, without the "send". */
    fun cancelSend() {
        armed = null
        spokenSend.reset()
        dictation.destroy()
        if (granted()) dictation.start(typed)
    }
    // On as the sheet opens, so TJ can just talk.
    LaunchedEffect(i.id) { if (granted()) dictation.start("") else problem = "Genlock needs the microphone to hear a spoken answer. Tap or type it." }
    fun toggleMic() {
        problem = null
        if (dictation.listening) { dictation.stop { finishing = false }; finishing = dictation.finishing; return }
        if (granted()) dictation.start(typed) else problem = "Genlock needs the microphone to hear a spoken answer. Tap or type it."
    }
    // Send waits for the recognizer's last words, as the main send does, so the end is not cut off.
    fun send() {
        if (dictation.finishing) return
        armed = null
        // A review before its last image: keep this comment, turn the page, carry on listening.
        if (images.isNotEmpty() && page < images.size - 1) {
            val wasListening = dictation.listening
            val dictating = dictation.stop { t -> finishing = false; typed = WalkPlan.spokenSend(t) ?: t; turnTo(page + 1); if (wasListening && granted()) dictation.start(typed) }
            finishing = dictation.finishing
            if (!dictating) turnTo(page + 1)
            return
        }
        val dictating = dictation.stop { text -> finishing = false; finalText(WalkPlan.spokenSend(text) ?: text)?.let { answer(it, via = "send tapped, dictated") } }
        finishing = dictation.finishing
        if (!dictating) finalText(typed)?.let { answer(it) }
    }
    fun leave(then: () -> Unit) { dictation.destroy(); then() }
    /** The review's finish step: every image's comment goes now, as one answer. */
    fun finishReview() {
        if (dictation.finishing) return
        armed = null
        val dictating = dictation.stop { t -> finishing = false; finalText(WalkPlan.spokenSend(t) ?: t)?.let { answer(it, via = "finish review, dictated") } }
        finishing = dictation.finishing
        if (!dictating) finalText(typed)?.let { answer(it, via = "finish review") }
    }
    /** Show image [to]: this one keeps its comment, the box takes that one's, and the mic carries on from it. */
    turnTo = { to ->
        if (images.isNotEmpty()) {
            val n = to.coerceIn(0, images.size - 1)
            comments[page] = typed
            if (n != page) {
                page = n
                typed = comments[n] ?: ""
                armed = null
                spokenSend.reset()
                if (dictation.listening) { dictation.destroy(); if (granted()) dictation.start(typed) }
                walker.diag("review: image ${n + 1} of ${images.size}")
            }
        }
    }

    // A stray back swipe must not close it: only the X does.
    Dialog(onDismissRequest = {}, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false,
        dismissOnBackPress = false, dismissOnClickOutside = false)) {
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            Column(Modifier.fillMaxSize().background(INK).systemBarsPadding().imePadding().padding(horizontal = 22.dp, vertical = 14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(listOf(i.project, i.task).filter { it.isNotBlank() }.joinToString("  ·  ").ifBlank { "QUESTION" }.uppercase(),
                        Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, letterSpacing = 2.sp, fontWeight = FontWeight.Bold,
                        color = QUESTION, maxLines = 1)
                    // Finish lives up here, away from the image: nothing below the image can slide it under a swipe.
                    if (images.size > 1) {
                        val done = (comments.filter { it.key != page && it.value.isNotBlank() }.size) + if (typed.isNotBlank()) 1 else 0
                        Button(onClick = { finishReview() }, enabled = done > 0 && !finishing, contentPadding = PaddingValues(horizontal = 14.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = QUESTION, contentColor = INK)) {
                            Icon(Icons.Default.DoneAll, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp))
                            Text("Finish · $done/${images.size}", fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(4.dp))
                    }
                    IconButton(onClick = { leave { walker.dismiss() } }, Modifier.size(48.dp)) { Icon(Icons.Default.Close, "Close and pause") }
                }
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                    Spacer(Modifier.height(18.dp))
                    Text(i.ask ?: i.say, fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.ExtraBold)
                    if (images.isNotEmpty()) {
                        Spacer(Modifier.height(16.dp))
                        ReviewImages(walker, images, page, comments.keys.filter { k -> !comments[k].isNullOrBlank() }.toSet() + if (typed.isNotBlank()) setOf(page) else emptySet()) { turnTo(it) }
                    }
                    if (i.options.isNotEmpty()) {
                        Spacer(Modifier.height(22.dp))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            i.options.forEach { o ->
                                Button(onClick = { android.util.Log.i("GenlockSend", "answer via=button item=${i.id}: \"$o\""); leave { Cues.answered(); walker.answer(o) } }, modifier = Modifier.heightIn(min = 52.dp),
                                    colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = INK)) {
                                    Text(o, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }
                }

                // Talk or type: one box. The mic fills it as TJ speaks; send is the only thing that sends.
                armed?.let { a -> SendingBar(a, step = images.isNotEmpty() && !a.finish && page < images.size - 1) { cancelSend() }; Spacer(Modifier.height(8.dp)) }
                Text(when {
                    problem != null -> problem!!
                    finishing -> "Catching your last words…"
                    listening && images.size > 1 && page < images.size - 1 -> "Listening. Comment, then say \"send\" for the next image, or \"finish review\"."
                    listening && images.size > 1 -> "Listening. Last image: say \"send\" to finish the review."
                    listening -> "Listening. Talk as long as you like, then say \"send\" (or tap send)."
                    else -> "Type an answer, or tap the mic to say it."
                }, style = MaterialTheme.typography.labelLarge, color = if (listening) QUESTION else Color.White.copy(alpha = 0.7f),
                    minLines = 2, maxLines = 2)
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.Bottom) {
                    // Tapping the box to fix the words stops the mic and disarms a spoken send: what TJ types stays.
                    OutlinedTextField(typed, { typed = it; armed = null }, Modifier.weight(1f).onFocusChanged {
                            if (it.isFocused) { armed = null; spokenSend.reset(); if (dictation.listening) dictation.stop { t -> finishing = false; typed = WalkPlan.spokenSend(t) ?: t }; finishing = dictation.finishing }
                        },
                        placeholder = { Text(if (listening) "Listening…" else if (images.isNotEmpty()) "Your comment on image ${page + 1}" else "Your answer") }, maxLines = 6,
                        colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                            focusedBorderColor = Color.White, unfocusedBorderColor = Color.White.copy(alpha = 0.4f), cursorColor = Color.White,
                            focusedPlaceholderColor = Color.White.copy(alpha = 0.5f), unfocusedPlaceholderColor = Color.White.copy(alpha = 0.5f)))
                    Spacer(Modifier.width(8.dp))
                    FilledIconButton(onClick = { toggleMic() }, Modifier.size(56.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = if (listening) QUESTION else Color.White.copy(alpha = 0.18f),
                            contentColor = if (listening) INK else Color.White)) {
                        Icon(if (listening) Icons.Default.Stop else Icons.Default.Mic, if (listening) "Stop listening" else "Answer by voice", Modifier.size(28.dp))
                    }
                    Spacer(Modifier.width(8.dp))
                    FilledIconButton(onClick = { send() }, Modifier.size(56.dp), enabled = (typed.isNotBlank() || listening || comments.values.any { it.isNotBlank() }) && !finishing,
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = Color.White, contentColor = INK)) {
                        if (images.isNotEmpty() && page < images.size - 1) Icon(Icons.Default.ChevronRight, "Keep this comment, next image", Modifier.size(28.dp))
                        else Icon(Icons.AutoMirrored.Filled.Send, if (images.isNotEmpty()) "Finish review" else "Send answer", Modifier.size(26.dp))
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { leave { walker.repeat() } }, Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.Default.Replay, null, tint = Color.White); Spacer(Modifier.width(6.dp)); Text("Hear again", color = Color.White)
                    }
                    TextButton(onClick = { leave { walker.next() } }, Modifier.heightIn(min = 48.dp)) {
                        Text("Skip", color = Color.White); Spacer(Modifier.width(6.dp)); Icon(Icons.Default.SkipNext, null, tint = Color.White)
                    }
                }
            }
        }
    }
}

/**
 * A review's images: swipe between them (or the arrows, or "next image"), tap one for full screen
 * with pinch zoom, and a strip of dots where a filled one marks each image already commented on.
 * An image still arriving says so.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ReviewImages(walker: Walker, images: List<ImageRef>, page: Int, commented: Set<Int>, turn: (Int) -> Unit) {
    val lines by walker.lines.collectAsStateWithLifecycle()
    val pager = androidx.compose.foundation.pager.rememberPagerState(initialPage = page) { images.size }
    var full by remember { mutableStateOf<Int?>(null) }
    // The pager and the sheet's page follow each other: a swipe turns the page, and so does "next image".
    LaunchedEffect(page) { if (pager.currentPage != page) pager.animateScrollToPage(page) }
    LaunchedEffect(pager.settledPage) { if (pager.settledPage != page) turn(pager.settledPage) }
    androidx.compose.foundation.pager.HorizontalPager(pager, Modifier.fillMaxWidth().height(320.dp), pageSpacing = 12.dp) { n ->
        val path = lines.firstOrNull { it.id == images[n].fid }?.file
        val img = remember(path) { path?.let { Files.preview(it, 1600)?.asImageBitmap() } }
        Box(Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp)).background(Color.White.copy(alpha = 0.08f))
            .clickable(enabled = img != null) { full = n }, contentAlignment = Alignment.Center) {
            if (img != null) androidx.compose.foundation.Image(img, images[n].caption ?: images[n].name, Modifier.fillMaxSize(),
                contentScale = androidx.compose.ui.layout.ContentScale.Fit)
            else Text("Image still arriving…", color = Color.White.copy(alpha = 0.6f), modifier = Modifier.padding(40.dp))
            // The count rides on the image, so it never scrolls out of sight (TJ: "I can't see the swipe count anymore").
            if (images.size > 1) Text("${n + 1} / ${images.size}", Modifier.align(Alignment.TopEnd).padding(10.dp)
                .clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 4.dp),
                color = Color.White, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        }
    }
    Spacer(Modifier.height(8.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { turn(page - 1) }, enabled = page > 0, modifier = Modifier.size(48.dp)) { Icon(Icons.Default.ChevronLeft, "Previous image") }
        Text(WalkPlan.imageLabel(images, page), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2)
        IconButton(onClick = { full = page }, Modifier.size(48.dp)) { Icon(Icons.Default.Fullscreen, "Full screen") }
        IconButton(onClick = { turn(page + 1) }, enabled = page < images.size - 1, modifier = Modifier.size(48.dp)) { Icon(Icons.Default.ChevronRight, "Next image") }
    }
    if (images.size > 1) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally)) {
        images.indices.forEach { n ->
            Box(Modifier.size(if (n == page) 12.dp else 9.dp).clip(CircleShape)
                .background(when { n in commented -> QUESTION; n == page -> Color.White; else -> Color.White.copy(alpha = 0.3f) })
                .clickable { turn(n) })
        }
    }
    full?.let { n -> ZoomedImages(images, n, lines, { full = null }) { turn(it) } }
}

/**
 * The review full screen: swipe between images, pinch to zoom, drag to pan when zoomed (swiping is
 * off while zoomed in), double-tap to reset, X to close. Closing leaves the sheet on the image shown.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ZoomedImages(images: List<ImageRef>, start: Int, lines: List<Line>, close: () -> Unit, turn: (Int) -> Unit) {
    val pager = androidx.compose.foundation.pager.rememberPagerState(initialPage = start) { images.size }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    LaunchedEffect(pager.settledPage) { scale = 1f; offset = androidx.compose.ui.geometry.Offset.Zero; turn(pager.settledPage) }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            androidx.compose.foundation.pager.HorizontalPager(pager, Modifier.fillMaxSize(), userScrollEnabled = scale == 1f) { n ->
                val path = lines.firstOrNull { it.id == images[n].fid }?.file
                val img = remember(path) { path?.let { Files.preview(it, 3000)?.asImageBitmap() } }
                val here = n == pager.currentPage
                if (img != null) androidx.compose.foundation.Image(img, WalkPlan.imageLabel(images, n), Modifier.fillMaxSize()
                    .pointerInput(n) {
                        // Pinch zooms; a one-finger drag pans only once zoomed, so at 1x it is the pager's swipe.
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            do {
                                val ev = awaitPointerEvent()
                                val zoom = ev.calculateZoom()
                                if (ev.changes.size > 1 || scale > 1f) {
                                    scale = (scale * zoom).coerceIn(1f, 8f)
                                    offset = if (scale == 1f) androidx.compose.ui.geometry.Offset.Zero else offset + ev.calculatePan()
                                    ev.changes.forEach { if (it.positionChanged()) it.consume() }
                                }
                            } while (ev.changes.any { it.pressed })
                        }
                    }
                    .pointerInput(n) { detectTapGestures(onDoubleTap = { scale = if (scale > 1f) 1f else 2.5f; offset = androidx.compose.ui.geometry.Offset.Zero }) }
                    .graphicsLayer { if (here) { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y } },
                    contentScale = androidx.compose.ui.layout.ContentScale.Fit)
                else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Image still arriving…", color = Color.White.copy(alpha = 0.6f)) }
            }
            Row(Modifier.fillMaxWidth().systemBarsPadding().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(WalkPlan.imageLabel(images, pager.currentPage), Modifier.weight(1f).padding(start = 12.dp), color = Color.White, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                IconButton(onClick = close, Modifier.size(48.dp)) { Icon(Icons.Default.Close, "Close full screen", tint = Color.White) }
            }
        }
    }
}

/** A spoken send waits this long, visibly, before it goes: any word or tap in that time cancels it. */
const val SEND_CONFIRM_MS = 2_000L

/** [finish]: a review's "finish review", which sends every comment; a plain send on a review keeps this comment and turns the page. */
class Armed(val text: String, val finish: Boolean = false) { val at = System.currentTimeMillis() }

/** "Sending in a moment": a bar that drains over [SEND_CONFIRM_MS], with Cancel. */
@Composable
private fun SendingBar(a: Armed, step: Boolean = false, cancel: () -> Unit) {
    val left = remember(a) { Animatable(1f) }
    LaunchedEffect(a) { left.animateTo(0f, tween(SEND_CONFIRM_MS.toInt(), easing = LinearEasing)) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(QUESTION.copy(alpha = 0.18f)).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (a.finish) "Heard \"finish review\". Sending every comment… cancel to stop it."
                else if (step) "Heard \"send\". Keeping this comment, next image…"
                else if (a.text.isBlank()) "Heard \"send\". Sending your answers so far… cancel to stop it."
                else "Heard \"send\". Sending… keep talking or cancel to stop it.", Modifier.weight(1f),
                style = MaterialTheme.typography.labelLarge, color = QUESTION)
            TextButton(onClick = cancel) { Text("Cancel", color = Color.White, fontWeight = FontWeight.Bold) }
        }
        Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.2f))) {
            Box(Modifier.fillMaxWidth(left.value).fillMaxHeight().clip(CircleShape).background(QUESTION))
        }
    }
}

/**
 * The wait before the walk moves on to the next item: full when it starts, empty when it does.
 * Gone as soon as TJ starts talking, since the walk then waits for him instead.
 */
@Composable
fun CountdownBar(walker: Walker, color: Color, track: Color, modifier: Modifier = Modifier) {
    val c by walker.countdown.collectAsStateWithLifecycle()
    val cd = c ?: return
    val left = remember(cd) { Animatable(1f) }
    LaunchedEffect(cd) {
        val gone = (System.currentTimeMillis() - cd.from).coerceIn(0, cd.ms)
        left.snapTo(1f - gone.toFloat() / cd.ms)
        left.animateTo(0f, tween((cd.ms - gone).toInt(), easing = LinearEasing))
    }
    Column(modifier) {
        Text("NEXT ITEM IN A MOMENT", style = MaterialTheme.typography.labelSmall, letterSpacing = 1.4.sp, color = color.copy(alpha = 0.7f))
        Spacer(Modifier.height(4.dp))
        Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(track)) {
            Box(Modifier.fillMaxWidth(left.value).fillMaxHeight().clip(CircleShape).background(color))
        }
    }
}
