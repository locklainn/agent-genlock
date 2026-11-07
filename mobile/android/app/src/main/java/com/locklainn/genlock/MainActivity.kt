package com.locklainn.genlock

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
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
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val link: Link by viewModels()
    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        tts = TextToSpeech(this) { if (it == TextToSpeech.SUCCESS) tts?.language = Locale.getDefault() }
        link.onReply = { text ->
            if (prefs().getBoolean("speak", true)) tts?.speak(text.replace(Regex("[*`#_]"), ""), TextToSpeech.QUEUE_ADD, null, null)
        }
        handleLink(intent)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { App(link, ::prefs) { tts?.stop() } }
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

    override fun onStart() { super.onStart(); link.open() }
    override fun onStop() { super.onStop(); link.close() }
    override fun onDestroy() { tts?.shutdown(); super.onDestroy() }
}

@Composable
fun App(link: Link, prefs: () -> android.content.SharedPreferences, hush: () -> Unit) {
    val pairing by link.pairing.collectAsStateWithLifecycle()
    if (pairing == null) { PairScreen(link); return }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val snackbar = remember { SnackbarHostState() }
    val flash by link.flash.collectAsStateWithLifecycle()
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
            NavigationBar {
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Icon(Icons.Default.Mic, null) }, label = { Text("Talk") })
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1; link.askStatus() }, icon = { Icon(Icons.Default.Dashboard, null) }, label = { Text("Status") })
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).consumeWindowInsets(pad).imePadding()) {
            if (tab == 0) TalkScreen(link) else StatusScreen(link) { tab = 0; link.say(it) }
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
            IconButton(onClick = {
                speak = !speak
                prefs().edit().putBoolean("speak", speak).apply()
                if (!speak) hush()
            }) { Icon(if (speak) Icons.Default.VolumeUp else Icons.Default.VolumeOff, if (speak) "Stop reading replies aloud" else "Read replies aloud") }
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Unpair this phone") }, onClick = { menu = false; link.unpair() })
            }
        },
    )
}

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
        if (dictation.listening) { dictation.stop(); return }
        val ok = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (ok) dictation.start(draft) else askMic.launch(android.Manifest.permission.RECORD_AUDIO)
    }
    fun send() {
        dictation.stop()
        link.say(draft)
        draft = ""
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
                FilledIconButton(onClick = { send() }, enabled = conn == Conn.CONNECTED && draft.isNotBlank(), modifier = Modifier.size(56.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Send")
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

@Composable
fun StatusScreen(link: Link, ask: (String) -> Unit) {
    val projects by link.projects.collectAsStateWithLifecycle()
    val at by link.statusAt.collectAsStateWithLifecycle()
    val conn by link.conn.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
        else if (ps.isEmpty()) item { Text("Nothing open on the laptop.") }
        else items(ps, key = { it.name }) { ProjectCard(it, ask) }
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
            for (s in p.sessions) {
                val (word, color) = when (s.state) {
                    "working" -> "working" to Color(0xFF7AA2F7)
                    "waiting" -> "needs you" to MaterialTheme.colorScheme.error
                    "done" -> "idle" to MaterialTheme.colorScheme.onSurfaceVariant
                    else -> s.state to MaterialTheme.colorScheme.onSurfaceVariant
                }
                Column {
                    Text("${s.name} · $word", style = MaterialTheme.typography.labelLarge, color = color)
                    s.task?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    if (s.said.isNotBlank()) Text(s.said, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            p.topGoal?.let { Text("Goal: $it", style = MaterialTheme.typography.bodySmall) }
            p.topTask?.let { Text("Next task: $it" + if (p.openTasks > 1) " (+${p.openTasks - 1} more)" else "", style = MaterialTheme.typography.bodySmall) }
            if (p.blocked > 0) Text("Blocked: ${p.blocked}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            for (d in p.due) Text("Due: $d", style = MaterialTheme.typography.bodySmall, color = Color(0xFFE0AF68))
            if (p.waiting.isNotEmpty()) {
                Text("Waiting on you: ${p.waiting.size}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error)
                Text(p.waiting.first(), style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

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
