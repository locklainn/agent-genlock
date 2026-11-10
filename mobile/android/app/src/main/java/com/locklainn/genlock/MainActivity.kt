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

    private fun finished(id: String?) { queued.remove(id); speaking.value = queued.isNotEmpty() }

    /** Silence the readout now and drop anything still queued. Read-aloud stays on for the next reply. */
    private fun hush() { queued.clear(); speaking.value = false; tts?.stop() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        tts = TextToSpeech(this) { if (it == TextToSpeech.SUCCESS) tts?.language = Locale.getDefault() }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) = finished(id)
            @Deprecated("Deprecated in Java") override fun onError(id: String?) = finished(id)
            override fun onError(id: String?, code: Int) = finished(id)
            override fun onStop(id: String?, interrupted: Boolean) = finished(id)
        })
        link.onReply = { text ->
            Cues.done()
            if (prefs().getBoolean("speak", true)) {
                val id = "reply-${nextId++}"
                queued.add(id); speaking.value = true
                // After the "reply done" sound, not over it.
                window.decorView.postDelayed({
                    if (id in queued && tts?.speak(text.replace(Regex("[*`#_]"), ""), TextToSpeech.QUEUE_ADD, null, id) != TextToSpeech.SUCCESS) finished(id)
                }, Cues.DONE_MS)
            }
        }
        handleLink(intent)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { App(link, ::prefs, speaking, ::hush) }
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
    override fun onDestroy() { tts?.shutdown(); super.onDestroy() }
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
fun App(link: Link, prefs: () -> android.content.SharedPreferences, speaking: StateFlow<Boolean>, hush: () -> Unit) {
    val ctx = LocalContext.current
    val pairing by link.pairing.collectAsStateWithLifecycle()
    if (pairing == null) { PairScreen(link); return }
    AskForNotifications()
    LaunchedEffect(pairing) { Watch.start(ctx) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val snackbar = remember { SnackbarHostState() }
    val flash by link.flash.collectAsStateWithLifecycle()
    val reading by speaking.collectAsStateWithLifecycle()
    LaunchedEffect(flash) {
        // Show first, clear after: clearing changes the key, which would cancel a snackbar still showing.
        val message = flash ?: return@LaunchedEffect
        snackbar.showSnackbar(message, duration = SnackbarDuration.Short)
        link.flash.value = null
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { TopBar(link, prefs, hush) },
        bottomBar = {
            // Above the tabs, so it can be reached from either screen while a reply is being read out.
            Column {
                if (reading) ReadingBar(hush)
                NavigationBar {
                    NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Icon(Icons.Default.Mic, null) }, label = { Text("Talk") })
                    NavigationBarItem(selected = tab == 1, onClick = { tab = 1; link.askStatus() }, icon = { Icon(Icons.Default.Dashboard, null) }, label = { Text("Status") })
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).consumeWindowInsets(pad).imePadding()) {
            if (tab == 0) TalkScreen(link) else StatusScreen(link) { tab = 0; link.say(it) }
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
fun TopBar(link: Link, prefs: () -> android.content.SharedPreferences, hush: () -> Unit) {
    val conn by link.conn.collectAsStateWithLifecycle()
    val laptop by link.laptop.collectAsStateWithLifecycle()
    val assistant by link.assistant.collectAsStateWithLifecycle()
    val name by link.assistantName.collectAsStateWithLifecycle()
    var speak by remember { mutableStateOf(prefs().getBoolean("speak", true)) }
    var menu by remember { mutableStateOf(false) }
    val (label, color) = when {
        conn == Conn.UNPAIRED -> "Not paired" to MaterialTheme.colorScheme.error
        conn != Conn.CONNECTED -> "Connecting…" to Color(0xFFE0AF68)
        laptop == "offline" -> "Laptop offline" to MaterialTheme.colorScheme.error
        assistant == "closed" -> "$name is not open" to Color(0xFFE0AF68)
        assistant == "busy" -> "$name is working…" to Color(0xFF7AA2F7)
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
            val waiting by link.waiting.collectAsStateWithLifecycle()
            FilledTonalButton(
                onClick = { link.say(STATUS_REQUEST) }, enabled = conn == Conn.CONNECTED && !waiting,
                contentPadding = PaddingValues(horizontal = 14.dp), modifier = Modifier.height(36.dp),
            ) { Text("Status update", style = MaterialTheme.typography.labelLarge) }
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

const val STATUS_REQUEST = "Status update: every project, each time. What changed since you last told me, what finished, and what is waiting on me; say no change for a project that has none."

@Composable
fun TalkScreen(link: Link) {
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
    val dictation = remember {
        Dictation(ctx,
            onText = { settled, partial -> draft = listOf(settled, partial).filter { it.isNotBlank() }.joinToString(" ") },
            onListening = { listening = it },
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
        val dictating = dictation.stop { text -> finishing = false; link.say(text); draft = "" }
        finishing = dictation.finishing   // read after: the callback may already have run
        if (!dictating) { link.say(draft); draft = "" }
    }

    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (lines.isEmpty()) item {
                Text("Tap the mic and talk to $name. Replies show here, and are read aloud unless you turn that off.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(lines, key = { it.id + it.who }) { Bubble(it, name) }
            if (waiting) item(key = "waiting") {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp, top = 4.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("$name is thinking…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        problem?.let { Text(it, Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium) }
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
            OutlinedTextField(
                value = draft, onValueChange = { draft = it }, modifier = Modifier.weight(1f),
                placeholder = { Text(if (listening) "Listening…" else "Say or type…") },
                maxLines = 6, shape = RoundedCornerShape(24.dp),
                trailingIcon = if (!listening && draft.isNotBlank()) {
                    { IconButton(onClick = { toggleMic() }) { Icon(Icons.Default.Mic, "Keep dictating") } }
                } else null,
            )
            Spacer(Modifier.width(8.dp))
            if (draft.isBlank() && !listening) {
                FilledIconButton(onClick = { toggleMic() }, modifier = Modifier.size(56.dp)) { Icon(Icons.Default.Mic, "Dictate") }
            } else {
                FilledIconButton(onClick = { send() }, enabled = conn == Conn.CONNECTED && draft.isNotBlank() && !finishing, modifier = Modifier.size(56.dp)) {
                    if (finishing) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    else Icon(Icons.AutoMirrored.Filled.Send, "Send")
                }
            }
        }
    }
}

@Composable
fun Bubble(line: Line, name: String) {
    val mine = line.who == Who.ME || line.who == Who.LAPTOP_PROMPT
    if (line.who == Who.NOTE || line.who == Who.INFO) {
        Text(line.text, Modifier.fillMaxWidth(), style = MaterialTheme.typography.labelMedium,
            color = if (line.who == Who.NOTE) MaterialTheme.colorScheme.error else Color(0xFF9ECE6A))
        return
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Text(
            when (line.who) { Who.ME -> if (line.pending) "You · sending…" else "You"; Who.LAPTOP_PROMPT -> "You, at the laptop"; else -> name },
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            SelectionContainer { Text(line.text, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyLarge) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatusScreen(link: Link, ask: (String) -> Unit) {
    val projects by link.projects.collectAsStateWithLifecycle()
    val at by link.statusAt.collectAsStateWithLifecycle()
    val conn by link.conn.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val ui = remember { ctx.getSharedPreferences("genlock-ui", Context.MODE_PRIVATE) }
    // Sessions: what each session is doing. Tasks: only goals and tasks, none of the agents' words.
    var tasksMode by remember { mutableStateOf(ui.getBoolean("statusTasks", false)) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf("Sessions", "Tasks").forEachIndexed { i, label ->
                    SegmentedButton(
                        selected = tasksMode == (i == 1),
                        onClick = { tasksMode = i == 1; ui.edit().putBoolean("statusTasks", tasksMode).apply() },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (at == 0L) "Not loaded yet" else "As of " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(at),
                    Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
                )
                TextButton(onClick = { link.askStatus() }, enabled = conn == Conn.CONNECTED) {
                    Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(4.dp)); Text("Refresh")
                }
            }
        }
        val ps = projects
        if (ps == null) item { Text(if (conn == Conn.CONNECTED) "Asking the laptop…" else "Waiting for a connection.") }
        else if (ps.isEmpty()) item { Text("No sessions open on the laptop.") }
        else if (tasksMode) {
            // Every project, every time: one with nothing current says so rather than vanishing.
            items(ps, key = { "t-" + it.name }) { ProjectTasks(it) }
        }
        else items(ps, key = { it.name }) { ProjectCard(it, ask) }
        item(key = "build") {
            Text("Genlock " + buildLabel(ctx), Modifier.fillMaxWidth().padding(top = 8.dp), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
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
        Text("Pair with your laptop", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text("On the laptop, run:\nnode mobile/bridge/pair.mjs\nthen scan the QR code it shows.", style = MaterialTheme.typography.bodyMedium)
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
