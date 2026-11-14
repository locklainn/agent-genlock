package com.locklainn.genlock

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The arrival screen: for a couple of seconds after a reply comes in, it says what came and that the
 * walk-through is about to start, so TJ is led in instead of landing straight on a question.
 * A tap starts the walk at once.
 */
@Composable
fun ArrivalScreen(link: Link, walker: Walker) {
    val shown by link.arriving.collectAsStateWithLifecycle()
    val pending by link.pending.collectAsStateWithLifecycle()
    // Counted from the live queue, so an item dropped while this shows is not still announced.
    val arrival = shown?.let { WalkPlan.arrivalNow(it, pending) ?: it }
    val a = arrival ?: return
    val name by link.assistantName.collectAsStateWithLifecycle()

    // In: fades up and settles from slightly large. Then the ring breathes until the walk starts.
    val enter = remember(shown) { Animatable(0f) }
    LaunchedEffect(shown) { enter.animateTo(1f, tween(450, easing = FastOutSlowInEasing)) }
    val pulse by rememberInfiniteTransition(label = "arrive").animateFloat(1f, 1.18f,
        infiniteRepeatable(tween(700, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "ring")

    Dialog(onDismissRequest = { walker.start() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            Column(
                Modifier.fillMaxSize().background(INK)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { walker.start() }
                    .systemBarsPadding().padding(28.dp)
                    .graphicsLayer { alpha = enter.value; val s = 1.06f - 0.06f * enter.value; scaleX = s; scaleY = s },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Box(Modifier.size(132.dp).graphicsLayer { scaleX = pulse; scaleY = pulse; alpha = 1.6f - pulse }.clip(CircleShape)
                        .background(QUESTION.copy(alpha = 0.35f)))
                    Box(Modifier.size(96.dp).clip(CircleShape).background(Color.White), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.GraphicEq, null, Modifier.size(48.dp), tint = INK)
                    }
                }
                Spacer(Modifier.height(36.dp))
                Text(if (a.status) "Your status update is in" else "$name replied", fontSize = 34.sp, lineHeight = 40.sp,
                    fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                // The same words it says aloud.
                Text(WalkPlan.arrivalLine(a.items, a.questions).removeSuffix("."), fontSize = 19.sp, fontWeight = FontWeight.SemiBold, color = Color.White.copy(alpha = 0.85f), textAlign = TextAlign.Center)
                if (a.projects.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(a.projects.take(4).joinToString(", ") + if (a.projects.size > 4) " and ${a.projects.size - 4} more" else "",
                        style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.65f), textAlign = TextAlign.Center)
                }
                Spacer(Modifier.height(40.dp))
                Text("Walking you through it…", style = MaterialTheme.typography.titleMedium, color = QUESTION)
                Spacer(Modifier.height(6.dp))
                Text(if (a.quiet) "Reading aloud is off: on screen only. Tap to start now" else "Tap to start now",
                    style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = 0.5f))
            }
        }
    }
}
