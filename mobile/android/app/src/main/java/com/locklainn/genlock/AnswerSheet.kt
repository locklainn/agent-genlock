package com.locklainn.genlock

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
    val dictation = remember(i.id) {
        Dictation(ctx,
            onText = { settled, partial ->
                val all = listOf(settled, partial).filter { it.isNotBlank() }.joinToString(" ")
                android.util.Log.i("GenlockSend", "heard settled=\"$settled\" partial=\"$partial\"")
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
            if (armed != null || !listening) continue
            spokenSend.ready(System.currentTimeMillis())?.let { answer ->
                android.util.Log.i("GenlockSend", "armed: \"$answer\"")
                typed = answer
                armed = Armed(answer)
            }
        }
    }
    LaunchedEffect(armed) {
        val a = armed ?: return@LaunchedEffect
        kotlinx.coroutines.delay(SEND_CONFIRM_MS)
        if (armed === a) { answer(a.text, via = "spoken send") }
    }
    DisposableEffect(i.id) { onDispose { dictation.destroy(); AudioHold.drop(AudioHold.MIC) } }
    val granted = { ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
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
        val dictating = dictation.stop { text -> finishing = false; (WalkPlan.spokenSend(text) ?: text).trim().takeIf { it.isNotEmpty() }?.let { answer(it, via = "send tapped, dictated") } }
        finishing = dictation.finishing
        if (!dictating) typed.trim().takeIf { it.isNotEmpty() }?.let { answer(it) }
    }
    fun leave(then: () -> Unit) { dictation.destroy(); then() }

    // A stray back swipe must not close it: only the X does.
    Dialog(onDismissRequest = {}, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false,
        dismissOnBackPress = false, dismissOnClickOutside = false)) {
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            Column(Modifier.fillMaxSize().background(INK).systemBarsPadding().imePadding().padding(horizontal = 22.dp, vertical = 14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(listOf(i.project, i.task).filter { it.isNotBlank() }.joinToString("  ·  ").ifBlank { "QUESTION" }.uppercase(),
                        Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, letterSpacing = 2.sp, fontWeight = FontWeight.Bold,
                        color = QUESTION, maxLines = 1)
                    IconButton(onClick = { leave { walker.dismiss() } }, Modifier.size(48.dp)) { Icon(Icons.Default.Close, "Close and pause") }
                }
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                    Spacer(Modifier.height(18.dp))
                    Text(i.ask ?: i.say, fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.ExtraBold)
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
                armed?.let { a -> SendingBar(a) { cancelSend() }; Spacer(Modifier.height(8.dp)) }
                Text(when {
                    problem != null -> problem!!
                    finishing -> "Catching your last words…"
                    listening -> "Listening. Talk as long as you like, then say \"send\" (or tap send)."
                    else -> "Type an answer, or tap the mic to say it."
                }, style = MaterialTheme.typography.labelLarge, color = if (listening) QUESTION else Color.White.copy(alpha = 0.7f))
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.Bottom) {
                    // Tapping the box to fix the words stops the mic and disarms a spoken send: what TJ types stays.
                    OutlinedTextField(typed, { typed = it; armed = null }, Modifier.weight(1f).onFocusChanged {
                            if (it.isFocused) { armed = null; spokenSend.reset(); if (dictation.listening) dictation.stop { t -> finishing = false; typed = WalkPlan.spokenSend(t) ?: t }; finishing = dictation.finishing }
                        },
                        placeholder = { Text(if (listening) "Listening…" else "Your answer") }, maxLines = 6,
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
                    FilledIconButton(onClick = { send() }, Modifier.size(56.dp), enabled = (typed.isNotBlank() || listening) && !finishing,
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = Color.White, contentColor = INK)) {
                        Icon(Icons.AutoMirrored.Filled.Send, "Send answer", Modifier.size(26.dp))
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

/** A spoken send waits this long, visibly, before it goes: any word or tap in that time cancels it. */
const val SEND_CONFIRM_MS = 2_000L

class Armed(val text: String) { val at = System.currentTimeMillis() }

/** "Sending in a moment": a bar that drains over [SEND_CONFIRM_MS], with Cancel. */
@Composable
private fun SendingBar(a: Armed, cancel: () -> Unit) {
    val left = remember(a) { Animatable(1f) }
    LaunchedEffect(a) { left.animateTo(0f, tween(SEND_CONFIRM_MS.toInt(), easing = LinearEasing)) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(QUESTION.copy(alpha = 0.18f)).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Heard \"send\". Sending… keep talking or cancel to stop it.", Modifier.weight(1f),
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
