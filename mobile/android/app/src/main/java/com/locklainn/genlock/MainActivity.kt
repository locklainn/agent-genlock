package com.locklainn.genlock

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.launch
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.withContext
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.flow.combine
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val link: Link by viewModels()
    private var tts: TextToSpeech? = null
    // Utterances queued or playing. The Stop button shows while this is non-empty.
    private val queued = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    private val speaking = MutableStateFlow(false)
    private var nextId = 0

    private lateinit var walker: Walker
    /** Writing a message, by voice or keyboard: a reply that comes now is held until it is sent. */
    private fun busy() = Walker.dictating.value || Walker.composing.value

    private fun finished(id: String?) {
        if (id?.startsWith("walk-") == true) { walker.utteranceDone(id); return }
        if (id?.startsWith("arrive-") == true) { walker.arrivalDone(); return }
        queued.remove(id)
        speaking.value = queued.isNotEmpty()
        if (queued.isEmpty()) releaseAudio()
    }

    /** Silence the readout now and drop anything still queued. Read-aloud stays on for the next reply. */
    private fun hush() { walker.pause(); queued.clear(); speaking.value = false; tts?.stop(); AudioHold.dropAll() }

    private val speech = AudioHold.speech
    private fun takeAudio() = AudioHold.take(this, AudioHold.REPLY)
    private fun releaseAudio() = AudioHold.drop(AudioHold.REPLY)

    /**
     * Setting only the language leaves the engine on its default voice for it, often an older,
     * flatter one. Ask for the best installed voice instead: highest quality, then same country,
     * then offline (no network lag mid-reply), then lowest latency.
     */
    private fun pickVoice(t: TextToSpeech) {
        val want = Locale.getDefault()
        t.language = want
        val best = runCatching { t.voices }.getOrNull().orEmpty()
            .filter { it.locale.language == want.language }
            .filter { TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features }
            .sortedWith(compareByDescending<android.speech.tts.Voice> { it.quality }
                .thenByDescending { it.locale.country == want.country }
                .thenBy { it.isNetworkConnectionRequired }
                .thenBy { it.latency })
            .firstOrNull()
        if (best != null && t.setVoice(best) == TextToSpeech.SUCCESS) {
            android.util.Log.i("Genlock", "voice: ${best.name} quality=${best.quality} network=${best.isNetworkConnectionRequired}")
        } else {
            android.util.Log.i("Genlock", "voice: engine default for $want")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        tts = TextToSpeech(this) { if (it == TextToSpeech.SUCCESS) { tts?.let { t -> pickVoice(t); t.setAudioAttributes(speech) } } }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) = finished(id)
            @Deprecated("Deprecated in Java") override fun onError(id: String?) = finished(id)
            override fun onError(id: String?, code: Int) = finished(id)
            override fun onStop(id: String?, interrupted: Boolean) = finished(id)
            override fun onRangeStart(id: String?, start: Int, end: Int, frame: Int) {
                if (id?.startsWith("walk-") == true) walker.range(id, end)
            }
        })
        walker = Walker(this, link) { tts }
        // A rebuilt screen (rotation, theme) lost the arrival screen's timer: announce it afresh.
        if (link.arriving.value != null) { link.arriving.value = null; walker.arrive() }
        // A reply's items are merged into the queue by Link. Nothing is read over a walk already on,
        // or over you while you dictate: the walk picks new items up in their place.
        link.onReply = {
            Cues.done()
            // The arrival screen shows whether or not replies are read aloud: with the speaker off it is
            // silent and waits for a tap. (Gating it on the speaker hid it with no sign why, TJ 2026-11-13.)
            // Typing or talking: never take the screen. The reply waits behind a small notice until he sends.
            if (busy()) Walker.held.value += 1
            else window.decorView.postDelayed({ if (busy()) Walker.held.value += 1 else walker.arrive() }, Cues.DONE_MS)
        }
        lifecycleScope.launch {
            combine(Walker.dictating, Walker.composing) { d, c -> d || c }.collect { on ->
                if (!on && Walker.held.value > 0) { Walker.held.value = 0; window.decorView.postDelayed({ walker.arrive() }, 600) }
            }
        }
        handleLink(intent)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { App(link, ::prefs, speaking, ::hush, walker) }
            }
        }
    }

    private fun prefs() = getSharedPreferences("genlock-ui", Context.MODE_PRIVATE)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    private fun handleLink(intent: Intent?) {
        intent?.dataString?.let { Pairing.parse(it) }?.let { link.pair(it) }
    }

    override fun onStart() {
        super.onStart()
        Watch.shown()
        link.open()
        Watch.start(this)
        getSystemService(android.app.NotificationManager::class.java).cancelAll()
    }
    override fun onStop() { super.onStop(); Watch.hidden(); link.close() }
    override fun onDestroy() { walker.pause(); tts?.shutdown(); AudioHold.dropAll(); super.onDestroy() }
}

/** Ask once for permission to post notifications (Android 13+), then start listening in the background. */
@Composable
fun AskForNotifications() {
    if (android.os.Build.VERSION.SDK_INT < 33) return
    val ctx = LocalContext.current
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
}

@Composable
fun App(link: Link, prefs: () -> android.content.SharedPreferences, speaking: StateFlow<Boolean>, hush: () -> Unit, walker: Walker) {
    val ctx = LocalContext.current
    val pairing by link.pairing.collectAsStateWithLifecycle()
    if (pairing == null) { PairScreen(link); return }
    AskForNotifications()
    LaunchedEffect(pairing) { Watch.start(ctx) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    // Two ways to see the Talk tab: Messages (the chat) or Focus (the walk-through, full screen). Remembered.
    var focus by remember { mutableStateOf(prefs().getBoolean("focus", false)) }
    // A walk always shows as the digest. In Messages mode it switches over for the walk (paused
    // included) and back once everything is heard; the toggle still works at any time.
    val walking by walker.active.collectAsStateWithLifecycle()
    val waitingItems by link.pending.collectAsStateWithLifecycle()
    var auto by remember { mutableStateOf(false) }
    LaunchedEffect(walking, waitingItems.isEmpty()) {
        if (walking && !focus) { focus = true; auto = true; tab = 0 }
        if (!walking && auto && waitingItems.isEmpty()) { focus = false; auto = false }
    }
    val snackbar = remember { SnackbarHostState() }
    val flash by link.flash.collectAsStateWithLifecycle()
    val reading by speaking.collectAsStateWithLifecycle()
    LaunchedEffect(flash) {
        // Show first, clear after: clearing changes the key, which would cancel a snackbar still showing.
        val message = flash ?: return@LaunchedEffect
        snackbar.showSnackbar(message, duration = SnackbarDuration.Short)
        link.flash.value = null
    }
    // A question opens full screen once its item has been read, over whichever tab is showing.
    AnswerSheet(walker)
    ArrivalScreen(link, walker)
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { TopBar(link, prefs, hush, focus) { focus = it; auto = false; prefs().edit().putBoolean("focus", it).apply(); if (it) tab = 0 } },
        bottomBar = {
            // Above the tabs, so it can be reached from either screen while a reply is being read out.
            Column {
                // On Talk the digest has the walk built in.
                // Messages mode keeps its one-line "N to hear · Walk" strip; a running walk becomes the digest.
                if (tab != 0 || !focus) WalkBar(link, walker)
                if (reading) ReadingBar(hush)
                NavigationBar {
                    NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Icon(Icons.Default.Mic, null) }, label = { Text("Talk") })
                    NavigationBarItem(selected = tab == 1, onClick = { tab = 1; link.askStatus() }, icon = { Icon(Icons.Default.Bolt, null) }, label = { Text("Live") })
                    NavigationBarItem(selected = tab == 2, onClick = { tab = 2 }, icon = { Icon(Icons.Default.Dashboard, null) }, label = { Text("Status") })
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).consumeWindowInsets(pad).imePadding()) {
            when (tab) {
                0 -> TalkScreen(link, walker, focus)
                1 -> LiveScreen(link) { tab = 0; link.say(it) }
                else -> SprintScreen(link)
            }
        }
    }
}

/**
 * The walk-through: the item being heard, with Repeat, Next and Send, and what is coming up (tap
 * one to hear it next). When no walk is on but items or answers are waiting, it offers to walk
 * them or send the answers. Send is the flush: the answers so far go as one batch, and anything
 * not yet heard stays for next time.
 */
@Composable
fun WalkBar(link: Link, walker: Walker) {
    val pending by link.pending.collectAsStateWithLifecycle()
    val held by link.held.collectAsStateWithLifecycle()
    val active by walker.active.collectAsStateWithLifecycle()
    val phase by walker.phase.collectAsStateWithLifecycle()
    val hearing by walker.hearing.collectAsStateWithLifecycle()
    val answered = held.count { it.answer != null }
    if (!active && pending.isEmpty() && answered == 0) return
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            val now = if (active) pending.firstOrNull() else null
            if (now != null) {
                // Old news is labelled with when it is from, so nothing stale passes as current.
                Text(listOfNotNull(now.label.ifBlank { "Reply" }, WalkPlan.asOf(now.at, System.currentTimeMillis())?.replaceFirstChar { it.lowercase() }, "${pending.size} to go").joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
                Text(now.say, style = MaterialTheme.typography.bodyMedium, maxLines = 3)
                Text(when (phase) {
                    Walker.Phase.SPEAKING -> "Reading…"
                    Walker.Phase.LISTENING -> hearing.ifBlank { "Listening… answer, or say next, repeat or send" }
                    Walker.Phase.IDLE -> ""
                }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                CountdownBar(walker, MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.surfaceVariant, Modifier.fillMaxWidth().padding(top = 4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { walker.pause() }) { Icon(Icons.Default.Pause, "Pause the walk") }
                    TextButton(onClick = { walker.repeat() }) { Text("Repeat") }
                    TextButton(onClick = { walker.next() }) { Text("Next") }
                    Spacer(Modifier.weight(1f))
                    Button(onClick = { walker.flush() }, enabled = answered > 0, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(if (answered > 0) "Send $answered" else "Send")
                    }
                }
                val upcoming = pending.drop(1)
                upcoming.take(3).forEach { i ->
                    Text("Next: ${i.label.ifBlank { i.say.take(40) }}", Modifier.fillMaxWidth().clickable { walker.jumpTo(i) }.padding(vertical = 6.dp),
                        style = MaterialTheme.typography.bodySmall, maxLines = 1)
                }
                if (upcoming.size > 3) Text("and ${upcoming.size - 3} more", style = MaterialTheme.typography.bodySmall)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(listOfNotNull(
                        if (pending.isNotEmpty()) "${pending.size} to hear" else null,
                        if (answered > 0) "$answered answer${if (answered == 1) "" else "s"} not sent" else null,
                    ).joinToString(" · "), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    if (answered > 0) TextButton(onClick = { walker.flush() }) { Text("Send $answered") }
                    if (pending.isNotEmpty()) Button(onClick = { walker.start() }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.Default.PlayArrow, null); Spacer(Modifier.width(6.dp)); Text("Walk")
                    }
                }
            }
        }
    }
}

@Composable
fun ReadingBar(hush: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.VolumeUp, null)
            Spacer(Modifier.width(10.dp))
            Text("Reading the reply aloud", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            Button(onClick = hush, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Default.Stop, null); Spacer(Modifier.width(6.dp)); Text("Stop")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TopBar(link: Link, prefs: () -> android.content.SharedPreferences, hush: () -> Unit, focus: Boolean, setFocus: (Boolean) -> Unit) {
    val conn by link.conn.collectAsStateWithLifecycle()
    val laptop by link.laptop.collectAsStateWithLifecycle()
    val assistant by link.assistant.collectAsStateWithLifecycle()
    val name by link.assistantName.collectAsStateWithLifecycle()
    var speak by remember { mutableStateOf(prefs().getBoolean("speak", true)) }
    var menu by remember { mutableStateOf(false) }
    // The Back up item's outcome, said in the snackbar: where the archive went, or why it did not.
    val backingUp by link.backup.state.collectAsStateWithLifecycle()
    LaunchedEffect(backingUp) {
        when (val s = backingUp) {
            is Backup.State.Working -> link.flash.value = "Backing up goals and tasks…"
            is Backup.State.Saved -> link.flash.value = "Backup saved: ${s.where}${s.caption?.let { " ($it)" } ?: ""}"
            is Backup.State.Failed -> link.flash.value = s.why
            else -> {}
        }
    }
    val (label, color) = when {
        conn == Conn.UNPAIRED -> "Not paired" to MaterialTheme.colorScheme.error
        conn != Conn.CONNECTED -> "Connecting…" to Color(0xFFE0AF68)
        laptop == "offline" -> "Offline" to MaterialTheme.colorScheme.error
        assistant == "closed" -> "$name is not open" to Color(0xFFE0AF68)
        assistant == "busy" -> "$name is working…" to Color(0xFF7AA2F7)
        assistant == "starting" -> "$name is starting…" to Color(0xFF7AA2F7)
        else -> "$name is ready" to Color(0xFF9ECE6A)
    }
    TopAppBar(
        title = {
            Column {
                Text("Genlock", fontWeight = FontWeight.SemiBold)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).padding(0.dp)) { Surface(Modifier.fillMaxSize(), shape = RoundedCornerShape(4.dp), color = color) {} }
                    Spacer(Modifier.width(6.dp))
                    Text(label, style = MaterialTheme.typography.labelMedium)
                }
            }
        },
        actions = {
            // One tap for the question asked most. Up here, not by the text box, where it read as an attachment.
            // Always pressable. The dot on it says whether the laptop is listening: a slow green pulse when
            // connected, amber while connecting, red when the laptop or the connection is down.
            val live = conn == Conn.CONNECTED && laptop != "offline"
            val dot = when {
                live -> Color(0xFF9ECE6A)
                conn == Conn.CONNECTING || conn == Conn.CONNECTED -> Color(0xFFE0AF68)
                else -> MaterialTheme.colorScheme.error
            }
            val pulse by rememberInfiniteTransition(label = "live").animateFloat(
                initialValue = 1f, targetValue = 0.35f,
                animationSpec = infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "live",
            )
            // Icon only, with the connection dot as a badge on its corner.
            FilledTonalIconButton(
                // Clears what is queued and fetches a fresh report: every project, every open question, since he last heard.
                onClick = { hush(); link.statusReport() },
                modifier = Modifier.size(44.dp)
                    .semantics { stateDescription = if (live) "Connected" else if (conn == Conn.CONNECTING) "Connecting" else "Not connected" },
            ) {
                Box {
                    // A newspaper: "catch me up", where Summarize read as a floppy disk (save).
                    Icon(Icons.Default.Newspaper, "Status report: catch me up")
                    Box(Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-3).dp).size(10.dp)
                        .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape).padding(1.5.dp)
                        .graphicsLayer { alpha = if (live) pulse else 1f }.background(dot, CircleShape))
                }
            }
            IconButton(onClick = { setFocus(!focus) }) {
                Icon(if (focus) Icons.Default.Forum else Icons.Default.GraphicEq, if (focus) "Show messages" else "Show digest")
            }
            IconButton(onClick = {
                speak = !speak
                prefs().edit().putBoolean("speak", speak).apply()
                if (!speak) hush()
            }) { Icon(if (speak) Icons.Default.VolumeUp else Icons.Default.VolumeOff, if (speak) "Stop reading replies aloud" else "Read replies aloud") }
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                val ctx = LocalContext.current
                DropdownMenuItem(text = { Text(buildLabel(ctx), style = MaterialTheme.typography.labelMedium) }, onClick = {}, enabled = false)
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(if (backingUp is Backup.State.Working) "Backing up…" else "Back up goals and tasks") },
                    enabled = backingUp !is Backup.State.Working,
                    onClick = { menu = false; link.askBackup() },
                )
                DropdownMenuItem(text = { Text("Unpair this phone") }, onClick = { menu = false; link.unpair() })
            }
        },
    )
}

/** "v0.1.450271 · built Nov 9, 11:52 AM". The version code is minutes since 2026-01-01 (build.gradle.kts), so it carries its own date. */
fun buildLabel(ctx: Context): String = runCatching {
    val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
    @Suppress("DEPRECATION") val code = if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    val built = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date((1767225600L + code * 60) * 1000))
    "v${info.versionName} · built $built"
}.getOrDefault("version unknown")


@Composable
fun TalkScreen(link: Link, walker: Walker, focus: Boolean) {
    val lines by link.lines.collectAsStateWithLifecycle()
    val name by link.assistantName.collectAsStateWithLifecycle()
    val conn by link.conn.collectAsStateWithLifecycle()
    var draft by rememberSaveable { mutableStateOf("") }
    val list = rememberLazyListState()
    val waiting by link.waiting.collectAsStateWithLifecycle()
    LaunchedEffect(lines.size, waiting) { if (lines.isNotEmpty()) list.animateScrollToItem(lines.size - 1 + if (waiting) 1 else 0) }

    val ctx = LocalContext.current
    var listening by remember { mutableStateOf(false) }
    var finishing by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    // A photo to send with the next message, already scaled and saved as a JPEG.
    var attachment by remember { mutableStateOf<java.io.File?>(null) }
    var preparing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        preparing = true
        scope.launch {
            val made = withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { Files.prepareImage(ctx, uri) } }
            preparing = false
            made.onSuccess { attachment = it }.onFailure { problem = "That photo could not be read: ${it.message}" }
        }
    }
    var dictated by remember { mutableStateOf(false) }
    // Composing means actively writing: a draft in the box with the keyboard in it, or a keystroke in
    // the last few seconds. A box that is merely selected, or an old draft he has left, holds nothing.
    var fieldFocused by remember { mutableStateOf(false) }
    var lastKey by remember { mutableLongStateOf(0L) }
    val focusManager = LocalFocusManager.current
    LaunchedEffect(draft.isNotBlank(), fieldFocused, lastKey) {
        val recent = { System.currentTimeMillis() - lastKey < Walker.TYPING_MS }
        Walker.composing.value = (draft.isNotBlank() && fieldFocused) || recent()
        // Keystrokes stop counting once he pauses: look again when that runs out.
        if (recent()) { kotlinx.coroutines.delay(Walker.TYPING_MS - (System.currentTimeMillis() - lastKey) + 50); Walker.composing.value = (draft.isNotBlank() && fieldFocused) || recent() }
    }
    DisposableEffect(Unit) { onDispose { Walker.composing.value = false } }
    val held by Walker.held.collectAsStateWithLifecycle()
    LaunchedEffect(waiting) { if (!waiting) AudioHold.drop(AudioHold.WAITING) }
    // A message you spoke holds the music paused through to the reply; a cancelled one lets it back.
    fun sent(ok: Boolean) {
        if (ok && dictated) AudioHold.take(ctx, AudioHold.WAITING)
        if (ok) dictated = false
        // Sent: replies held while he wrote open now, full screen (leaving the box ends composing).
        if (ok) lastKey = 0L
        if (ok && Walker.held.value > 0) focusManager.clearFocus()
    }
    // Spoken "send": the same rule as the answer sheet. Only the word or the button sends; a pause never does.
    val spokenSend = remember { SpokenSend() }
    var armed by remember { mutableStateOf<Armed?>(null) }
    val dictation = remember {
        Dictation(ctx,
            onText = { settled, partial ->
                draft = listOf(settled, partial).filter { it.isNotBlank() }.joinToString(" ")
                // Saying "send" sends, as in the answer sheet; more words after it take it back.
                if (armed != null && WalkPlan.spokenSend(draft) == null) armed = null
                spokenSend.heard(draft, System.currentTimeMillis())
            },
            onListening = {
                listening = it
                // Music pauses while you talk. A dictated message keeps it paused until its reply is read.
                if (it) { dictated = true; AudioHold.take(ctx, AudioHold.MIC) } else AudioHold.drop(AudioHold.MIC)
                Walker.dictating.value = it
            },
            onProblem = { problem = it })
            .also { d -> (ctx as? android.app.Activity)?.intent?.getIntExtra("minlen", 0)?.takeIf { it > 0 }?.let { d.minLength = it } }
    }
    DisposableEffect(Unit) { onDispose { dictation.destroy() } }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) dictation.start(draft) else problem = "Genlock needs the microphone to take dictation."
    }
    fun toggleMic() {
        problem = null
        if (dictation.listening) {
            dictation.stop { finishing = false }
            finishing = dictation.finishing   // read after: the callback may already have run
            return
        }
        val ok = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (ok) dictation.start(draft) else askMic.launch(android.Manifest.permission.RECORD_AUDIO)
    }
    // Send while dictating waits for the recognizer's last words before sending, so the end of the
    // sentence is not cut off. The draft clears only once the text has gone.
    fun send() {
        if (dictation.finishing) return
        Cues.sendHeard(ctx)
        armed = null; spokenSend.reset()
        val dictating = dictation.stop { heard ->
            finishing = false
            val text = if (dictated) WalkPlan.spokenSend(heard) ?: heard else heard
            val ok = link.say(text, attachment)
            sent(ok)
            if (ok) { draft = ""; attachment = null } else draft = text
        }
        finishing = dictation.finishing   // read after: the callback may already have run
        if (!dictating) { val ok = link.say(draft, attachment); sent(ok); if (ok) { draft = ""; attachment = null } }
    }

    // Dictating, "send" stood as the last word for SpokenSend.QUIET_MS: arm the countdown.
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(200)
            if (armed != null || !dictated) continue
            spokenSend.ready(System.currentTimeMillis())?.let { text ->
                if (text.isBlank() && attachment == null) { spokenSend.reset(); draft = ""; return@let }
                link.diag("chat: spoken send armed after: \"${spokenSend.lastHeard.takeLast(60)}\"")
                draft = text
                Cues.sendHeard(ctx)
                armed = Armed(text)
            }
        }
    }
    LaunchedEffect(armed) {
        val a = armed ?: return@LaunchedEffect
        kotlinx.coroutines.delay(SEND_CONFIRM_MS)
        if (armed !== a) return@LaunchedEffect
        armed = null
        spokenSend.reset()
        dictation.destroy()
        Cues.answered()
        val ok = link.say(a.text, attachment)
        sent(ok)
        if (ok) { draft = ""; attachment = null } else draft = a.text
    }

    Column(Modifier.fillMaxSize()) {
        if (focus) FocusView(link, walker, Modifier.weight(1f)) else LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (lines.isEmpty()) item {
                Text("Tap the mic and talk to $name. Replies show here, and are read aloud unless you turn that off.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(lines, key = { it.id + it.who }) { Bubble(it, name, onRetry = { link.retry(it) }, onOpen = { Files.open(ctx, it.file!!, it.mime) }) }
            if (waiting) item(key = "waiting") {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp, top = 4.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("$name is thinking…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        // A reply came while he was writing: say so quietly, never over the box. It opens once he sends, or on a tap.
        AnimatedVisibility(held > 0) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.secondaryContainer).padding(start = 14.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.MarkChatUnread, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
                Spacer(Modifier.width(8.dp))
                Text(if (held == 1) "$name replied · opens when you send" else "$held replies from $name · open when you send",
                    Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = { Walker.held.value = 0; focusManager.clearFocus(); walker.arrive() }) { Text("Open") }
            }
        }
        problem?.let { Text(it, Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium) }
        // The photo going with the next message, with a way to take it back off.
        if (attachment != null || preparing) {
            Row(Modifier.padding(start = 16.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box {
                    val thumb = remember(attachment) { attachment?.let { Files.preview(it.path, 256)?.asImageBitmap() } }
                    if (thumb != null) {
                        Image(thumb, "Photo to send", Modifier.size(72.dp).clip(RoundedCornerShape(10.dp)), contentScale = ContentScale.Crop)
                    } else {
                        Box(Modifier.size(72.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) }
                    }
                }
                if (attachment != null) IconButton(onClick = { attachment = null }) { Icon(Icons.Default.Close, "Remove photo") }
            }
        }
        armed?.let { a ->
            SendingBar(a, Modifier.padding(horizontal = 12.dp)) {
                armed = null; spokenSend.reset(); dictation.destroy()
                if (androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED) dictation.start(draft)
            }
        }
        // Stop and Send do opposite things, so they sit at opposite ends of the row, never side by side.
        // The right-hand button is the one next step: Mic when there is nothing yet, Send once there is.
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (listening) {
                OutlinedIconButton(
                    onClick = { toggleMic() }, modifier = Modifier.size(48.dp),
                    border = androidx.compose.foundation.BorderStroke(1.5.dp, MaterialTheme.colorScheme.error),
                ) { Icon(Icons.Default.Stop, "Stop dictating", tint = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.width(8.dp))
            }
            if (!listening) {
                IconButton(onClick = { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !preparing) {
                    Icon(Icons.Default.AddPhotoAlternate, "Attach a photo")
                }
            }
            OutlinedTextField(
                value = draft, onValueChange = { draft = it; lastKey = System.currentTimeMillis() }, modifier = Modifier.weight(1f).onFocusChanged { fieldFocused = it.isFocused },
                placeholder = { Text(if (listening) "Listening…" else "Say or type…") },
                maxLines = 6, shape = RoundedCornerShape(24.dp),
                trailingIcon = if (!listening && draft.isNotBlank()) {
                    { IconButton(onClick = { toggleMic() }) { Icon(Icons.Default.Mic, "Keep dictating") } }
                } else null,
            )
            Spacer(Modifier.width(8.dp))
            if (draft.isBlank() && attachment == null && !listening) {
                FilledIconButton(onClick = { toggleMic() }, modifier = Modifier.size(56.dp)) { Icon(Icons.Default.Mic, "Dictate") }
            } else {
                FilledIconButton(onClick = { send() }, enabled = conn == Conn.CONNECTED && (draft.isNotBlank() || attachment != null) && !finishing && !preparing, modifier = Modifier.size(56.dp)) {
                    if (finishing) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    else Icon(Icons.AutoMirrored.Filled.Send, "Send")
                }
            }
        }
    }
}

@Composable
fun Bubble(line: Line, name: String, onRetry: () -> Unit = {}, onOpen: () -> Unit = {}) {
    val mine = line.who == Who.ME || line.who == Who.LAPTOP_PROMPT
    if (line.who == Who.NOTE || line.who == Who.INFO) {
        Text(line.text, Modifier.fillMaxWidth(), style = MaterialTheme.typography.labelMedium,
            color = if (line.who == Who.NOTE) MaterialTheme.colorScheme.error else Color(0xFF9ECE6A))
        return
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Text(
            when (line.who) { Who.ME -> when (line.stage) {
                Stage.SENDING -> "You · sending…"; Stage.DELIVERED -> "You · delivered"; Stage.PICKED -> "You · $name has it"; Stage.FAILED -> "You · not delivered"
            }; Who.LAPTOP_PROMPT -> "You, at your desk"; else -> name },
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Column {
                line.file?.let { path ->
                    if (Files.isImage(line.mime)) {
                        // Decoded small for the chat; a tap opens the full image.
                        val img = remember(path) { Files.preview(path, 1024)?.asImageBitmap() }
                        if (img != null) Image(img, line.text.ifEmpty { "Image" },
                            Modifier.fillMaxWidth().heightIn(max = 360.dp).clickable(onClick = onOpen), contentScale = ContentScale.Fit)
                        else Text("Image could not be shown", Modifier.padding(12.dp))
                    } else {
                        Row(Modifier.clickable(onClick = onOpen).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.AttachFile, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(java.io.File(path).name.substringAfter('-'), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
                if (line.text.isNotEmpty()) SelectionContainer { Text(line.text, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyLarge) }
            }
        }
        if (line.failed) {
            TextButton(onClick = onRetry) {
                Icon(Icons.Default.Refresh, null, Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("Retry")
            }
        }
    }
}

/**
 * The Live tab: work in progress from both sides at once. Each project as the Mac grid shows it
 * (its sessions and what each is doing), then the goals those sessions are moving and their
 * tasks, from the records. Replaces the old Status > Sessions and Status > Tasks views.
 */
@Composable
fun LiveScreen(link: Link, ask: (String) -> Unit) {
    val projects by link.projects.collectAsStateWithLifecycle()
    val statusAt by link.statusAt.collectAsStateWithLifecycle()
    val grid by link.grid.collectAsStateWithLifecycle()
    val conn by link.conn.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    // Records come by asking; the grid is pushed. Ask again every 30s while the tab is open.
    LaunchedEffect(conn) { while (conn == Conn.CONNECTED) { link.askStatus(); kotlinx.coroutines.delay(30_000) } }
    val g = grid?.takeIf { it.mac == "open" }
    val byName = (projects ?: emptyList()).associateBy { it.name }
    val key = { gp: GridProject -> java.io.File(gp.id).name }
    val gridNames = g?.projects?.map(key)?.toSet() ?: emptySet()
    val recordsOnly = (projects ?: emptyList()).filter { it.name !in gridNames }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        g != null && conn == Conn.CONNECTED -> "Live from the Mac"
                        statusAt == 0L -> "Not loaded yet"
                        else -> "As of " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(statusAt)
                    },
                    Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
                )
                TextButton(onClick = { link.askStatus() }, enabled = conn == Conn.CONNECTED) {
                    Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(4.dp)); Text("Refresh")
                }
            }
        }
        if (grid == null && projects == null) item { Text(if (conn == Conn.CONNECTED) "Fetching data…" else "Waiting for a connection.") }
        else {
            if (grid != null && g == null) item { Text("The Genlock app is not running on the Mac.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (g != null) {
                val needs = g.projects.sumOf { p -> p.sessions.count { it.attention == "waiting" || it.kind == "needsYou" } }
                if (needs > 0) item(key = "needs") {
                    Text(if (needs == 1) "1 session needs you" else "$needs sessions need you",
                        style = MaterialTheme.typography.titleSmall, color = MAC_RED, fontWeight = FontWeight.SemiBold)
                }
                items(g.projects, key = { "l-" + it.id }) { gp -> LiveProjectCard(gp.name, gp.hub, gp.sessions, byName[key(gp)]?.goals ?: emptyList(), ask) }
            }
            items(recordsOnly, key = { "r-" + it.name }) { p -> LiveProjectCard(p.name, false, emptyList(), p.goals, ask, p.sessions) }
            if (g?.projects.isNullOrEmpty() && recordsOnly.isEmpty()) item { Text("Nothing in progress.") }
        }
        item(key = "build") {
            Text("Genlock " + buildLabel(ctx), Modifier.fillMaxWidth().padding(top = 8.dp), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

/** One project on the Live tab: its sessions first (grid rows, else the records' view of them), then its goals in flight. */
@Composable
fun LiveProjectCard(name: String, hub: Boolean, rows: List<GridSession>, goals: List<GoalTasks>, ask: (String) -> Unit, sessions: List<Session> = emptyList()) {
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                val n = if (rows.isNotEmpty()) rows.size else sessions.size
                if (n > 0) Text(if (n == 1) "1 session" else "$n sessions",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!hub) TextButton(onClick = { ask("What's happening in $name?") }) { Text("Ask") }
            }
            for (s in rows) GridSessionRow(s)
            if (rows.isEmpty()) for (s in sessions) SessionLine(s)
            if (goals.isNotEmpty()) Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("In progress", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for (gt in goals) GoalCard(gt)
            }
        }
    }
}

/**
 * The Status tab: the sprint report. What got finished this sprint (one week, from one Claude
 * weekly reset to the next), with a picker for past sprints and for any range of days.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SprintScreen(link: Link) {
    val report by link.sprint.collectAsStateWithLifecycle()
    val error by link.sprintError.collectAsStateWithLifecycle()
    val loading by link.sprintLoading.collectAsStateWithLifecycle()
    val conn by link.conn.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    // What is picked: a sprint offset ("0", "-1", ..), or a day range.
    var sel by rememberSaveable { mutableStateOf("0") }
    var range by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    LaunchedEffect(conn, sel, range) {
        if (conn != Conn.CONNECTED) return@LaunchedEffect
        val r = range
        if (r != null) { val parts = r.split(".."); val a = parts[0]; val b = parts.getOrElse(1) { a }; link.askSprint(from = a, to = b) }
        else link.askSprint(sel)
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "picker") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    OutlinedButton(onClick = { menu = true }, enabled = report != null) {
                        val r = report
                        Text(when {
                            r == null -> "This sprint"
                            r.kind == "dates" -> r.label
                            r.current -> "This sprint · ${r.label}"
                            else -> "Sprint · ${r.label}"
                        }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Icon(Icons.Default.ArrowDropDown, null)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        for (sp in report?.sprints ?: emptyList()) DropdownMenuItem(
                            text = { Text((if (sp.offset == 0) "This sprint · " else "") + sp.label + "  ·  ${sp.done} done") },
                            onClick = { menu = false; range = null; sel = sp.offset.toString() },
                        )
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text("Date range…") }, leadingIcon = { Icon(Icons.Default.DateRange, null) },
                            onClick = { menu = false; picking = true })
                    }
                }
                if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        }
        val r = report
        when {
            error != null -> item { Text(error!!, color = MaterialTheme.colorScheme.error) }
            r == null -> item { Text(if (conn == Conn.CONNECTED) "Fetching data…" else "Waiting for a connection.") }
            else -> {
                item(key = "total") {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            (if (r.tasks == 1) "1 task done" else "${r.tasks} tasks done") +
                                (if (r.goals > 0) " · " + (if (r.goals == 1) "1 goal closed" else "${r.goals} goals closed") else ""),
                            style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
                        )
                        if (!r.confirmed) Text("Sprint days are provisional until the weekly reset time is set on the Mac.",
                            style = MaterialTheme.typography.labelSmall, color = MAC_AMBER)
                    }
                }
                if (r.projects.isEmpty()) item { Text("Nothing finished in this range.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                items(r.projects, key = { "s-" + it.name }) { SprintProjectCard(it) }
            }
        }
        item(key = "build") {
            Text("Genlock " + buildLabel(ctx), Modifier.fillMaxWidth().padding(top = 8.dp), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
    if (picking) {
        val state = rememberDateRangePickerState()
        val day = { ms: Long -> java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString() }
        DatePickerDialog(
            onDismissRequest = { picking = false },
            confirmButton = {
                TextButton(enabled = state.selectedStartDateMillis != null, onClick = {
                    val a = state.selectedStartDateMillis ?: return@TextButton
                    val b = state.selectedEndDateMillis ?: a
                    range = "${day(a)}..${day(b)}"
                    picking = false
                }) { Text("Show") }
            },
            dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } },
        ) { DateRangePicker(state, Modifier.weight(1f)) }
    }
}

/** One project's finished work: goals it closed, then its done tasks under their goals, newest first. */
@Composable
fun SprintProjectCard(p: SprintProject) {
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("${p.tasks.size} done", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            for (g in p.goalsDone) Row(verticalAlignment = Alignment.CenterVertically) {
                Pill("goal done", DONE_GREEN); Spacer(Modifier.width(8.dp))
                Text(g.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            for ((goal, ts) in p.tasks.groupBy { it.goal ?: "No goal" }) {
                Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(goal, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        for (t in ts) Row(verticalAlignment = Alignment.Top) {
                            Text(shortDay(t.closed), Modifier.width(52.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Column(Modifier.weight(1f)) {
                                Text(t.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (t.title != t.name) Text(t.title, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** "Thu 12", in the phone's zone, from an ISO time. */
fun shortDay(iso: String): String = runCatching {
    java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("EEE d"))
}.getOrDefault("")

val MAC_RED = Color(0xFFFF5C7A)
val MAC_AMBER = Color(0xFFFFB84D)
val MAC_GREEN = Color(0xFF34E5A0)
val MAC_BLUE = Color(0xFF5B9BFF)
val MAC_VIOLET = Color(0xFFB18CFF)

/** A wait's color, as the Mac colors it: work happening colored, nothing happening muted. */
@Composable
fun waitColor(state: String?): Color = when (state) {
    "testing" -> MAC_GREEN
    "queued" -> MAC_VIOLET.copy(alpha = 0.8f)
    "waiting" -> MaterialTheme.colorScheme.onSurfaceVariant
    else -> MAC_BLUE
}

/** The status row's color, the same as a grid pane's status row on the Mac. */
@Composable
fun kindColor(s: GridSession): Color = when (s.kind) {
    "working" -> WORKING_BLUE
    "workingUnrecorded", "untracked" -> MAC_AMBER
    "needsYou" -> MAC_RED
    "waitingOn" -> waitColor(s.waitState)
    "paused" -> MaterialTheme.colorScheme.onSurfaceVariant
    else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
}

/** "4m 12s" since a wait began, ticking. */
@Composable
fun elapsed(since: Long): String {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) { while (true) { now = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
    val s = ((now - since) / 1000).coerceAtLeast(0)
    return when { s < 60 -> "${s}s"; s < 3600 -> "${s / 60}m ${s % 60}s"; else -> "${s / 3600}h ${(s % 3600) / 60}m" }
}

/** One project as its Mac grid shows it: its Assistant first, then each session. */
@Composable
fun GridProjectCard(p: GridProject, ask: (String) -> Unit) {
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(if (p.sessions.size == 1) "1 session" else "${p.sessions.size} sessions",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!p.hub) TextButton(onClick = { ask("What's happening in ${p.name}?") }) { Text("Ask") }
            }
            for (s in p.sessions) GridSessionRow(s)
        }
    }
}

/** A pane: its tab's dot and title, then its status row (what it is doing), the detail, its goal. */
@Composable
fun GridSessionRow(s: GridSession) {
    val color = kindColor(s)
    // The tab dot: needs you red, finished amber, else the wait's color, else running green.
    val dot = when {
        s.attention == "waiting" -> MAC_RED
        s.attention == "done" -> MAC_AMBER
        s.wait != null -> waitColor(s.wait.state)
        s.running -> MAC_GREEN
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(Modifier.fillMaxWidth().padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(dot, androidx.compose.foundation.shape.CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(s.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            when (s.attention) {
                "waiting" -> Pill("needs you", MAC_RED)
                "done" -> Pill("finished", MAC_AMBER)
            }
        }
        Row(Modifier.padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            val line = buildString {
                append(s.headline)
                if (s.task != null) append(" ").append(s.task)
            }
            Text(line, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium, color = color,
                fontWeight = if (s.kind == "working" || s.kind == "needsYou" || s.kind == "waitingOn") FontWeight.Medium else FontWeight.Normal,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (s.kind == "waitingOn" && s.wait != null) {
                Spacer(Modifier.width(6.dp))
                Text(elapsed(s.wait.since), style = MaterialTheme.typography.labelMedium, color = color.copy(alpha = 0.75f))
            }
            if (s.more > 0) { Spacer(Modifier.width(6.dp)); Text("+${s.more}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        s.detail?.let {
            Text(it, Modifier.padding(start = 16.dp), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val meta = listOfNotNull(
            s.goal?.let { g -> "Goal: ${g.title}" + if (g.total > 0) " · ${g.done}/${g.total}" else "" },
            s.questions.takeIf { it > 0 }?.let { if (it == 1) "1 question" else "$it questions" },
        )
        if (meta.isNotEmpty()) Text(meta.joinToString("  ·  "), Modifier.padding(start = 16.dp), style = MaterialTheme.typography.labelMedium,
            color = if (s.questions > 0) MAC_VIOLET else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun ProjectCard(p: Project, ask: (String) -> Unit) {
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                TextButton(onClick = { ask("What's happening in ${p.name}?") }) { Text("Ask") }
            }
            for (s in p.sessions) SessionLine(s)
        }
    }
}

/** A session as the Mac's Tasks view shows it: its title and state, the goal it serves, its task. */
@Composable
fun SessionLine(s: Session) {
    val (word, color) = when (s.state) {
        "working" -> "working" to Color(0xFF7AA2F7)
        "waiting" -> "needs you" to MaterialTheme.colorScheme.error
        "holding" -> "running a job" to Color(0xFF7AA2F7)
        "done" -> "idle" to MaterialTheme.colorScheme.onSurfaceVariant
        else -> s.state to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.width(8.dp))
            Text(word, style = MaterialTheme.typography.labelMedium, color = color)
        }
        s.goal?.let { g ->
            Text("Goal: ${g.title}" + if (g.total > 0) " · ${g.done}/${g.total}" else "",
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val w = s.work
        if (w != null) TaskCard(w)
        else Text("No task recorded", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (s.said.isNotBlank()) Text(s.said, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f))
    }
}

/** One project in Tasks mode: a minimal card per goal its open sessions are working on, holding their task cards. */
@Composable
fun ProjectTasks(p: Project) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(p.name, Modifier.padding(start = 4.dp, top = 4.dp), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (p.goals.isEmpty()) Text("No task recorded by its sessions.", Modifier.padding(start = 4.dp),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (g in p.goals) GoalCard(g)
    }
}

@Composable
fun GoalCard(g: GoalTasks) {
    val done = g.status == "done"
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(g.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (done) Pill("goal done", DONE_GREEN)
                else if (g.total > 0) Text("${g.done}/${g.total}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (g.total > 0) LinearProgressIndicator(
                progress = { g.done.toFloat() / g.total }, modifier = Modifier.fillMaxWidth().height(3.dp),
                color = if (done) DONE_GREEN else WORKING_BLUE, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )
            for (t in g.tasks) TaskCard(t)
        }
    }
}

@Composable
fun TaskCard(t: TaskItem) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest) {
        Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) { TaskLine(t) }
    }
}

@Composable
fun Pill(text: String, color: Color) {
    Surface(shape = RoundedCornerShape(50), color = color.copy(alpha = 0.16f)) {
        Text(text, Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, color = color)
    }
}

val WORKING_BLUE = Color(0xFF7AA2F7)
val DONE_GREEN = Color(0xFF9ECE6A)

/** A task's name, its state as a pill, then proof, holder and its latest update. */
@Composable
fun TaskLine(t: TaskItem) {
    val (word, color) = when {
        t.status == "in_progress" -> "in progress" to WORKING_BLUE
        t.status == "done" -> "done" to DONE_GREEN
        t.status == "blocked" -> "blocked" to MaterialTheme.colorScheme.error
        else -> "open" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    val done = t.status == "done"
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(t.name ?: t.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.width(8.dp))
            Pill(word, color)
        }
        val meta = listOfNotNull(t.proof.takeIf { it.isNotBlank() && it != "none" && !done }, t.who?.let { "on $it" }, ago(t.at))
        if (meta.isNotEmpty()) Text(meta.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!done) t.latest?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** "5m ago", from an ISO time. */
fun ago(iso: String): String? = runCatching {
    val s = ((System.currentTimeMillis() - java.time.Instant.parse(iso).toEpochMilli()) / 1000).coerceAtLeast(0)
    when { s < 60 -> "just now"; s < 3600 -> "${s / 60}m ago"; s < 86400 -> "${s / 3600}h ago"; else -> "${s / 86400}d ago" }
}.getOrNull()

@Composable
fun PairScreen(link: Link) {
    val ctx = LocalContext.current
    var pasted by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Pair this phone", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text("On your Mac, run:\nnode mobile/bridge/pair.mjs\nthen scan the QR code it shows.", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = {
            val scanner = GmsBarcodeScanning.getClient(ctx, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
            scanner.startScan()
                .addOnSuccessListener { code ->
                    val p = Pairing.parse(code.rawValue ?: "")
                    if (p == null) error = "That QR code is not a Genlock pairing." else link.pair(p)
                }
                .addOnFailureListener { error = "The scanner could not start: ${it.message}" }
        }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
            Icon(Icons.Default.QrCodeScanner, null); Spacer(Modifier.width(8.dp)); Text("Scan QR code")
        }
        Text("Or paste the link:", style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(value = pasted, onValueChange = { pasted = it; error = null }, modifier = Modifier.fillMaxWidth(), placeholder = { Text("genlock://pair?…") })
        OutlinedButton(onClick = {
            val p = Pairing.parse(pasted)
            if (p == null) error = "That is not a Genlock pairing link." else link.pair(p)
        }, enabled = pasted.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Pair") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}
