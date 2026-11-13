package com.locklainn.genlock

import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/** What the QR code carries: where the relay is, which room, and the key that opens it. */
data class Pairing(val relay: String, val room: String, val key: String) {
    fun socketUrl(): String {
        val base = relay.trimEnd('/').replaceFirst(Regex("^http"), "ws")
        return "$base/room/$room?role=phone&key=$key"
    }

    companion object {
        fun parse(link: String): Pairing? {
            val uri = runCatching { Uri.parse(link.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "genlock" || uri.host != "pair") return null
            val relay = uri.getQueryParameter("relay") ?: return null
            val room = uri.getQueryParameter("room")?.takeIf { it.matches(Regex("[a-f0-9]{32}")) } ?: return null
            val key = uri.getQueryParameter("key")?.takeIf { it.matches(Regex("[a-f0-9]{64}")) } ?: return null
            return Pairing(relay, room, key)
        }
    }
}

enum class Who { ME, LAPTOP_PROMPT, ASSISTANT, NOTE, INFO }

/** `failed`: a message of yours that did not reach the laptop. It stays, with Retry, so nothing is lost. */
/** `file`: a local path to an image or file this message carries, sent or received; `mime` its type. */
/** `picked`: the Assistant has started on it (the bridge saw it reach its conversation). */
data class Line(val id: String, val who: Who, val text: String, val t: Long, val pending: Boolean = false, val failed: Boolean = false,
                val file: String? = null, val mime: String? = null, val picked: Boolean = false) {
    /** Where a message of yours is: sending, delivered (the laptop has it), picked up, or not delivered. */
    val stage: Stage get() = when { failed -> Stage.FAILED; pending -> Stage.SENDING; picked -> Stage.PICKED; else -> Stage.DELIVERED }
}

enum class Stage { SENDING, DELIVERED, PICKED, FAILED }

/**
 * Messages of yours the laptop has not confirmed, kept on the phone so one is never lost without a
 * trace: if Android ends the app before the ack, the next start shows it as not delivered, with Retry.
 */
object Outbox {
    fun encode(lines: List<Line>): String = JSONArray().apply {
        lines.filter { it.who == Who.ME && (it.pending || it.failed) }.forEach { l ->
            put(JSONObject().put("id", l.id).put("text", l.text).put("t", l.t).apply { l.file?.let { put("file", it) }; l.mime?.let { put("mime", it) } })
        }
    }.toString()

    /** What was unconfirmed when the app last ran: every one of them is now not delivered. */
    fun decode(raw: String?): List<Line> = runCatching {
        val a = JSONArray(raw ?: "[]")
        (0 until a.length()).map { val o = a.getJSONObject(it)
            Line(o.getString("id"), Who.ME, o.optString("text"), o.optLong("t"), failed = true,
                file = o.optString("file").takeIf { f -> f.isNotEmpty() }, mime = o.optString("mime").takeIf { m -> m.isNotEmpty() }) }
    }.getOrDefault(emptyList())
}

data class Session(val name: String, val state: String, val said: String, val task: String?,
                   val title: String = name, val goal: SessionGoal? = null, val work: TaskItem? = null)

data class SessionGoal(val title: String, val done: Int, val total: Int)

data class GoalTasks(val title: String, val done: Int, val total: Int, val tasks: List<TaskItem>, val status: String = "active")

data class TaskItem(val title: String, val status: String, val proof: String, val latest: String?, val at: String, val who: String?, val name: String? = null)

data class Project(
    val name: String,
    val goals: List<GoalTasks>,
    val sessions: List<Session>,
)

/** The Mac grid view, as the app wrote it (PhoneGrid.swift): one row per pane, in the grid's order. */
data class GridWait(val state: String, val gist: String, val headline: String, val since: Long)

data class GridSession(
    val key: String, val title: String, val running: Boolean, val assistant: Boolean,
    /** "waiting" (needs you, red dot) or "done" (finished, amber dot) until seen on the Mac. */
    val attention: String?,
    val phase: String?, val wait: GridWait?,
    /** working, workingUnrecorded, needsYou, waitingOn, paused, untracked, waitingForWork, ended, loading */
    val kind: String, val headline: String, val task: String?, val taskStatus: String?, val detail: String?, val waitState: String?,
    val more: Int, val goal: SessionGoal?, val questions: Int,
)

data class GridProject(val id: String, val name: String, val hub: Boolean, val attention: String?, val sessions: List<GridSession>)

/** mac: "open", or "closed" when the app that wrote it is not running. */
data class Grid(val mac: String, val projects: List<GridProject>, val at: Long)

/** The sprint report (genlock sprint --all --json): what got done in one sprint or a date range. */
data class SprintTask(val name: String, val title: String, val closed: String, val goal: String?)
data class SprintGoal(val name: String, val title: String, val at: String)
data class SprintProject(val name: String, val tasks: List<SprintTask>, val goalsDone: List<SprintGoal>)
/** One sprint for the picker. offset 0 is the current one, -1 the last. */
data class SprintRef(val id: String, val label: String, val offset: Int, val done: Int)
data class SprintReport(
    val label: String, val kind: String, val current: Boolean, val tasks: Int, val goals: Int,
    val resetText: String, val confirmed: Boolean, val projects: List<SprintProject>, val sprints: List<SprintRef>,
)

enum class Conn { CONNECTING, CONNECTED, OFFLINE, UNPAIRED }

/** One connection to the relay, and everything the screens show. */
class Link(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("genlock", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var retryMs = 1000L
    private var wantOpen = false

    private val _pairing = MutableStateFlow(loadPairing())
    val pairing: StateFlow<Pairing?> = _pairing
    val conn = MutableStateFlow(Conn.OFFLINE)
    val laptop = MutableStateFlow("unknown")
    val assistant = MutableStateFlow("unknown")
    val assistantName = MutableStateFlow(prefs.getString("assistantName", null) ?: "Assistant")
    val lines = MutableStateFlow(Outbox.decode(prefs.getString("outbox", null)))
    private fun saveOutbox() = prefs.edit().putString("outbox", Outbox.encode(lines.value)).apply()
    val projects = MutableStateFlow<List<Project>?>(null)
    val statusAt = MutableStateFlow(0L)
    /** Pushed by the bridge each time the Mac's grid changes. */
    val grid = MutableStateFlow<Grid?>(null)
    val gridAt = MutableStateFlow(0L)
    /** The Status tab's sprint report, the range it was asked for, and why it failed if it did. */
    val sprint = MutableStateFlow<SprintReport?>(null)
    val sprintError = MutableStateFlow<String?>(null)
    val sprintLoading = MutableStateFlow(false)
    private var sprintAsk: String? = null
    /** A short message to show once, briefly (a snackbar), then forget. */
    val flash = MutableStateFlow<String?>(null)

    /** A message was sent and the Assistant has not answered yet. */
    val waiting = MutableStateFlow(false)
    private val giveUp = Runnable { waiting.value = false }
    /** The "Assistant started" sound has played for the message now waiting. */
    private var startCued = false

    /** Once per message: the Assistant has picked it up. */
    private fun cueStarted() {
        if (!waiting.value || startCued) return
        startCued = true
        Cues.started()
    }

    /** The Assistant started on [of], or (from an older bridge) on the oldest delivered message not yet picked up. */
    private fun picked(of: String?) {
        val target = lines.value.firstOrNull { it.who == Who.ME && it.id == of }
            ?: lines.value.firstOrNull { it.who == Who.ME && it.stage == Stage.DELIVERED }
            ?: return
        lines.update { list -> list.map { if (it.id == target.id && it.who == Who.ME) it.copy(picked = true, pending = false, failed = false) else it } }
        saveOutbox()
    }

    /** This build's version, sent in hello so the laptop's log says which build a phone runs. */
    private val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"

    private val assembler = FileAssembler(Files.receivedDir(app))

    /** The Back up button: every project's goals and tasks from the laptop, saved to Downloads/Genlock. */
    val backup = Backup(app)

    /** Walk items in the Genlock voice, a clip per sentence: made on the phone, or from the Mac's speaker until the model is here. */
    val clips = Clips(java.io.File(app.cacheDir, "clips"))

    /** The voice model on the phone, downloaded once and kept across updates. */
    val voiceModel = VoiceModel(app)
    val phoneVoice = PhoneVoice(voiceModel, clips) { android.util.Log.i("genlock", it) }
    init {
        // On (TJ, 2026-11-12: the voices are installed in the phone app, downloaded once from our own
        // link). Until the model is here, clips come from the Mac as before. prefs "phoneVoice" false turns it off.
        if (prefs.getBoolean("phoneVoice", true)) voiceModel.ensure()
        viewModelScope.launch {
            var lastMb = -100L
            voiceModel.state.collect { st ->
                when (st) {
                    // Every 50 MB, not every MB: the log is for people.
                    is VoiceModel.State.Downloading -> if ((st.done shr 20) - lastMb >= 50) { lastMb = st.done shr 20; diag("voice model: downloading $lastMb of ${st.total shr 20} MB") }
                    is VoiceModel.State.Failed -> diag("voice model: failed: ${st.why}")
                    else -> diag("voice model: ${st.javaClass.simpleName}")
                }
            }
        }
        // Once it is here, tell the bridge (no more clips from the Mac) and load an engine ahead of the first walk.
        viewModelScope.launch {
            voiceModel.state.collect { if (it == VoiceModel.State.Ready) { phoneVoice.warm(); if (conn.value == Conn.CONNECTED) sendHello() } }
        }
    }

    /** Each project's voice, as the bridge last sent it with an item: kept, so a restart reads in the same voices. */
    private val voices: MutableMap<String, PhoneVoice.Voice> = loadVoices()
    private fun voiceKey(project: String) = project.trim().lowercase()
    private fun voiceFor(project: String) = voices[voiceKey(project)] ?: PhoneVoice.Voice.DEFAULT
    private fun loadVoices(): MutableMap<String, PhoneVoice.Voice> = runCatching {
        val o = JSONObject(prefs.getString("voices", "{}")!!)
        o.keys().asSequence().mapNotNull { k -> PhoneVoice.voiceOf(o.optJSONObject(k))?.let { k to it } }.toMap().toMutableMap()
    }.getOrDefault(mutableMapOf())
    private fun saveVoices() = prefs.edit().putString("voices", JSONObject().apply {
        voices.forEach { (k, v) -> put(k, JSONObject().put("parts", JSONArray().apply { v.parts.forEach { put(JSONArray().put(it.first).put(it.second)) } }).put("speed", v.speed)) }
    }.toString()).apply()

    /** Make an item's clips on the phone: [id] is an item's id, late:<project> for the "came in" line, or a line with its [text]. */
    private fun voiceOnPhone(id: String, first: Boolean, text: String? = null): Boolean {
        if (!phoneVoice.ready()) return false
        if (text != null) { phoneVoice.want(id, text, PhoneVoice.Voice.DEFAULT, first); return true }
        if (id.startsWith("late:")) {
            val project = id.removePrefix("late:")
            phoneVoice.want(id, PhoneVoice.LATE, voiceFor(project), first)
            return true
        }
        val item = pending.value.firstOrNull { it.id == id } ?: return false
        phoneVoice.want(id, PhoneVoice.spokenOf(item), voiceFor(item.project), first)
        return true
    }

    /** The Walker needs an item's clips: made here when the model is in; else asked of the bridge (missed while away). */
    fun askClips(item: String, text: String? = null) {
        if (voiceOnPhone(item, first = true, text)) return
        if (conn.value == Conn.CONNECTED) send(JSONObject().put("kind", "clips").put("item", item).apply { if (text != null) put("text", text) })
    }

    /** A line for the bridge's log: what the phone saw while speaking. Only while connected; never queued. */
    fun diag(text: String) { if (conn.value == Conn.CONNECTED) send(JSONObject().put("kind", "diag").put("text", text)) }

    private fun sendHello() = send(JSONObject().put("kind", "hello").put("lastSeen", prefs.getLong("lastSeen", 0)).put("version", version)
        // The phone makes its own voice: the bridge sends no clips, so no speech crosses the network.
        .put("ondevice", phoneVoice.ready()))

    /** A reply arrived; its items are already merged into [pending]. */
    var onReply: (() -> Unit)? = null

    /**
     * The walk-through queue: items not yet heard, in the order to hear them. While a walk is on,
     * the first is the one being heard. New items merge in by WalkPlan's rule and never interrupt.
     * Kept across restarts, so an unheard item is never lost.
     */
    val pending = MutableStateFlow(loadItems("pending"))
    /** Answers given and not sent yet: they go as one batch when the walk ends or TJ sends early. */
    val held = MutableStateFlow(loadAnswers())
    /** Subjects heard in the current walk: news about them is read last, as "came in while we talked". */
    val heardKeys = mutableSetOf<String>()
    /** A walk is on: its first pending item is being heard, so a merge treats it as heard. */
    var walking = false
    /**
     * The question whose answer sheet is open. Kept here, not in the Walker, because this outlives the
     * screen: a rotation or theme change rebuilds the activity, and the sheet must still be there after.
     */
    val asking = MutableStateFlow<Item?>(null)
    /** A reply just came and a walk is about to start: the arrival screen shows it. */
    val arriving = MutableStateFlow<Arrival?>(null)
    /** Items heard in the latest walk, in order, for the Focus screen's agenda. Cleared when a walk starts. */
    val walked = MutableStateFlow<List<Item>>(emptyList())

    /**
     * When TJ last talked to the Assistant away from the phone (the laptop or Remote Control), on the
     * laptop's clock. Items from before it are past: the conversation has moved on without the phone.
     */
    private var movedAt = prefs.getLong("movedAt", 0)

    /** Throw out the pending items the conversation has moved past. Held answers stay: they are TJ's words. */
    private fun dropPast() {
        val kept = WalkPlan.current(pending.value, movedAt, keepHead = walking)
        val n = pending.value.size - kept.size
        if (n == 0) return
        pending.value = kept
        saveItems()
        flash.value = "Dropped $n older item${if (n == 1) "" else "s"}: you carried on elsewhere."
    }

    fun mergeItems(items: List<Item>) {
        val head = if (walking) pending.value.take(1) else emptyList()
        val keys = if (walking) heardKeys + head.map { it.key } else emptySet()
        pending.value = head + WalkPlan.merge(pending.value.drop(head.size), items, keys)
        saveItems()
    }

    fun moveFirst(item: Item) {
        pending.value = listOf(item) + pending.value.filterNot { it.id == item.id }
        saveItems()
    }

    /** The item being heard is finished with, answered or not. */
    fun heard(item: Item, answer: Answer?) {
        heardKeys += item.key
        walked.value = walked.value.filterNot { it.id == item.id } + item
        pending.value = pending.value.filterNot { it.id == item.id }
        answer?.let { held.value = held.value + it }
        saveItems()
    }

    /**
     * Sends every held answer as one message, so a walk costs one Assistant turn. Nothing is sent
     * when there is no actual answer: hearing items needs no reply. False when not connected (kept).
     */
    fun sendAnswers(): Boolean {
        val batch = held.value
        if (batch.none { it.answer != null }) { held.value = emptyList(); saveItems(); return true }
        if (conn.value != Conn.CONNECTED) { flash.value = "Not connected. Your answers are kept and go once connected."; return false }
        val arr = JSONArray()
        batch.forEach { a ->
            arr.put(JSONObject().put("item", a.item.id).put("project", a.item.project).put("task", a.item.task)
                .apply { a.item.ask?.let { put("ask", it) }; a.answer?.let { put("answer", it) }; if (a.skipped) put("skipped", true) })
        }
        val summary = batch.joinToString("\n") { a -> "${a.item.label.ifBlank { "Reply" }}: ${a.answer ?: "skipped"}" }
        sayJson(JSONObject().put("kind", "say").put("text", summary).put("answers", arr).put("left", pending.value.size), summary, null, null)
        held.value = emptyList()
        saveItems()
        return true
    }

    private fun itemJson(i: Item) = JSONObject().put("id", i.id).put("project", i.project).put("task", i.task).put("kind", i.kind)
        .put("say", i.say).put("late", i.late).put("at", i.at).apply { i.ask?.let { put("ask", it) }; i.re?.let { put("re", it) }; put("options", JSONArray(i.options)) }

    private fun itemOf(o: JSONObject) = Item(o.optString("id"), o.optString("project"), o.optString("task"), o.optString("kind", "update"),
        o.optString("say"), o.optString("ask").takeIf { it.isNotEmpty() },
        o.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(), o.optBoolean("late"),
        o.optString("re").takeIf { it.isNotEmpty() }, o.optLong("at"))

    private fun loadItems(key: String): List<Item> = runCatching {
        val a = JSONArray(prefs.getString(key, "[]")); (0 until a.length()).map { itemOf(a.getJSONObject(it)) }
    }.getOrDefault(emptyList())

    private fun loadAnswers(): List<Answer> = runCatching {
        val a = JSONArray(prefs.getString("held", "[]"))
        (0 until a.length()).map { val o = a.getJSONObject(it); Answer(itemOf(o.getJSONObject("item")), o.optString("answer").takeIf { s -> s.isNotEmpty() }, o.optBoolean("skipped")) }
    }.getOrDefault(emptyList())

    private fun saveItems() {
        val held = JSONArray().apply { this@Link.held.value.forEach { a -> put(JSONObject().put("item", itemJson(a.item)).put("skipped", a.skipped).apply { a.answer?.let { put("answer", it) } }) } }
        prefs.edit().putString("pending", JSONArray().apply { pending.value.forEach { put(itemJson(it)) } }.toString())
            .putString("held", held.toString()).apply()
    }

    private fun loadPairing(): Pairing? {
        val relay = prefs.getString("relay", null) ?: return null
        val room = prefs.getString("room", null) ?: return null
        val key = prefs.getString("key", null) ?: return null
        return Pairing(relay, room, key)
    }

    fun pair(p: Pairing) {
        prefs.edit().putString("relay", p.relay).putString("room", p.room).putString("key", p.key).putLong("lastSeen", 0).putLong("movedAt", 0).apply()
        movedAt = 0
        _pairing.value = p
        socket?.close(1000, "re-paired")
        socket = null
        lines.value = emptyList()
        Watch.stop(getApplication())   // it holds the old room; MainActivity's App restarts it on the new one
        flash.value = "Paired"
        if (wantOpen) open()
    }

    fun unpair() {
        prefs.edit().clear().apply()
        Watch.stop(getApplication())
        socket?.close(1000, "unpaired")
        socket = null
        _pairing.value = null
        conn.value = Conn.UNPAIRED
    }

    fun open() {
        wantOpen = true
        val p = _pairing.value ?: run { conn.value = Conn.UNPAIRED; return }
        if (socket != null) return
        conn.value = Conn.CONNECTING
        socket = http.newWebSocket(Request.Builder().url(p.socketUrl()).build(), object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) = main.post {
                retryMs = 1000
                conn.value = Conn.CONNECTED
                sendHello()
                askStatus()
                // Clips sent while the phone was away are lost: ask again for the next few items not yet whole.
                if (!phoneVoice.ready()) pending.value.take(3).filterNot { clips.whole(it.id) }.forEach { askClips(it.id) }
            }.let { }

            override fun onMessage(ws: WebSocket, text: String) = main.post { receive(text) }.let { }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(1000, null) }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) = main.post { dropped(ws, null) }.let { }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) =
                main.post { dropped(ws, response?.code) }.let { }
        })
    }

    fun close() {
        wantOpen = false
        socket?.close(1000, "background")
        socket = null
        conn.value = Conn.OFFLINE
    }

    private fun dropped(ws: WebSocket, code: Int?) {
        if (socket !== ws) return
        socket = null
        if (code == 401) {
            conn.value = Conn.UNPAIRED
            note("This phone is no longer paired. Pair again.")
            return
        }
        conn.value = Conn.OFFLINE
        if (!wantOpen) return
        main.postDelayed({ if (wantOpen && socket == null) open() }, retryMs)
        retryMs = (retryMs * 2).coerceAtMost(30_000)
    }

    private fun send(msg: JSONObject): String {
        val id = msg.optString("id").ifEmpty { UUID.randomUUID().toString() }
        msg.put("id", id).put("t", System.currentTimeMillis())
        socket?.send(msg.toString())
        return id
    }

    /** False when it could not go: the caller keeps the draft, so nothing typed or dictated is lost. */
    fun say(text: String, attachment: java.io.File? = null, mime: String = "image/jpeg"): Boolean {
        val clean = text.trim()
        if (clean.isEmpty() && attachment == null) return true
        if (conn.value != Conn.CONNECTED) {
            flash.value = "Not connected. Your message is still in the box; send it again once connected."
            return false
        }
        // The file goes first, in chunks; the say that follows names it, so the laptop hands both over together.
        val fid = attachment?.let { f ->
            val fid = UUID.randomUUID().toString()
            Files.chunks(fid, f, mime).forEach { send(it) }
            fid
        }
        val say = JSONObject().put("kind", "say").put("text", clean)
        fid?.let { say.put("files", JSONArray().put(it)) }
        sayJson(say, clean, attachment?.path, attachment?.let { mime })
        return true
    }

    private fun sayJson(say: JSONObject, shown: String, file: String?, mime: String?) {
        val id = send(say)
        lines.update { it + Line(id, Who.ME, shown, System.currentTimeMillis(), pending = true, file = file, mime = mime) }
        saveOutbox()
        // No ack in time (the connection dropped as it went): mark it failed, so it can be retried.
        main.postDelayed({ fail(id, null) }, 20_000L)
        waiting.value = true
        startCued = false
        main.removeCallbacks(giveUp)
        main.postDelayed(giveUp, 15 * 60_000L)
    }

    /** Send a failed message again. It moves to the bottom, as a new message. */
    fun retry(line: Line) {
        if (conn.value != Conn.CONNECTED) { flash.value = "Not connected yet. Retry once it says ready."; return }
        lines.update { list -> list.filterNot { it.id == line.id && it.who == Who.ME } }
        saveOutbox()
        say(line.text, line.file?.let { java.io.File(it) }?.takeIf { it.exists() }, line.mime ?: "image/jpeg")
    }

    private fun fail(id: String, why: String?) {
        if (lines.value.none { it.id == id && it.who == Who.ME && it.pending }) return
        waiting.value = false
        lines.update { list -> list.map { if (it.id == id && it.who == Who.ME) it.copy(pending = false, failed = true) else it } }
        saveOutbox()
        Cues.failed()
        why?.let { note(it) }
    }

    /** A sprint (current, previous, -N, a date inside it) or, with FROM, a range of whole days (YYYY-MM-DD). */
    fun askSprint(sel: String = "current", from: String? = null, to: String? = null) {
        if (conn.value != Conn.CONNECTED) return
        val m = JSONObject().put("kind", "sprint")
        if (from != null) m.put("from", from).put("to", to ?: from) else m.put("sprint", sel)
        val id = UUID.randomUUID().toString()
        sprintAsk = id
        sprintLoading.value = true
        sprintError.value = null
        send(m.put("id", id))
    }

    fun askBackup() {
        if (conn.value != Conn.CONNECTED) { backup.failed("Not connected, so there is nothing to back up yet."); return }
        val id = UUID.randomUUID().toString()
        backup.asked(id)
        send(JSONObject().put("kind", "backup").put("id", id))
    }

    fun askStatus() {
        if (conn.value == Conn.CONNECTED) send(JSONObject().put("kind", "status"))
    }

    private fun note(text: String) {
        lines.update { it + Line(UUID.randomUUID().toString(), Who.NOTE, text, System.currentTimeMillis()) }
    }

    private fun seen(t: Long) {
        if (t > prefs.getLong("lastSeen", 0)) prefs.edit().putLong("lastSeen", t).apply()
    }

    private fun receive(raw: String) {
        val m = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val t = m.optLong("t", System.currentTimeMillis())
        when (m.optString("kind")) {
            "state" -> {
                m.optString("laptop").takeIf { it.isNotEmpty() }?.let { laptop.value = it }
                m.optString("assistant").takeIf { it.isNotEmpty() }?.let {
                    if (it == "busy" && assistant.value != "busy") cueStarted()
                    assistant.value = it
                }
                m.optString("assistantName").takeIf { it.isNotEmpty() }?.let {
                    assistantName.value = it
                    prefs.edit().putString("assistantName", it).apply()
                }
                if (m.optString("laptop") == "offline") assistant.value = "unknown"
            }
            "ack" -> {
                val of = m.optString("of")
                if (lines.value.any { it.id == of && it.pending }) Cues.sent()
                // The Assistant was closed: the laptop kept the message and is starting it.
                if (m.optBoolean("queued")) lines.update { it + Line(UUID.randomUUID().toString(), Who.INFO,
                    "${assistantName.value} was not open, so it is starting with your message.", t) }
                // A late ack also rescues a message already marked not delivered: it did arrive.
                lines.update { list -> list.map { if (it.id == of && it.who == Who.ME) it.copy(pending = false, failed = false) else it } }
                saveOutbox()
                seen(t)
            }
            // A file from the Assistant, a chunk at a time. Shown once whole; a replay of one already shown is skipped.
            "file" -> {
                val whole = runCatching { assembler.add(m) }.getOrNull() ?: return
                seen(whole.t)
                if (lines.value.any { it.id == whole.fid }) return
                lines.update { it + Line(whole.fid, Who.ASSISTANT, whole.caption ?: "", whole.t, file = whole.file.path, mime = whole.mime) }
            }
            "file-ack" -> {}
            "backup-file" -> backup.chunk(m)
            "clip" -> {
                val item = m.optString("item").ifEmpty { return }
                when {
                    m.optBoolean("failed") -> clips.failed(item)
                    m.optBoolean("done") -> clips.done(item, m.optInt("n"))
                    m.has("data") -> runCatching { android.util.Base64.decode(m.optString("data"), android.util.Base64.DEFAULT) }.getOrNull()
                        ?.let { clips.add(item, m.optInt("i"), m.optString("text"), it) }
                }
            }
            // The bridge saw the phone's message reach the Assistant's conversation.
            "started" -> { picked(m.optString("of").ifEmpty { null }); cueStarted() }
            "reply" -> {
                val id = m.optString("turn").ifEmpty { m.optString("id") }
                seen(t)
                if (lines.value.any { it.id == id }) return
                val text = m.optString("text")
                lines.update { it + Line(id, Who.ASSISTANT, text, t) }
                waiting.value = false
                // Items to walk; an older bridge sends none, and the whole reply is one item.
                // Each item names its project's voice (the bridge asks lib/speaker.mjs): remember it per project.
                m.optJSONArray("items")?.let { a ->
                    for (k in 0 until a.length()) a.optJSONObject(k)?.let { o ->
                        PhoneVoice.voiceOf(o.optJSONObject("voice"))?.let { v -> voices[voiceKey(o.optString("project"))] = v }
                    }
                    saveVoices()
                }
                val items = m.optJSONArray("items")?.let { a -> (0 until a.length()).map { itemOf(a.getJSONObject(it)) } }
                    ?.filter { it.say.isNotBlank() }?.takeIf { it.isNotEmpty() }
                    ?: listOf(Item("$id-0", "", "", "update", text.replace(Regex("[*`#_]"), "")))
                // What this answers: the last thing said to the Assistant before it, from the phone or the laptop.
                val re = lines.value.lastOrNull { it.who == Who.ME || it.who == Who.LAPTOP_PROMPT }?.text?.takeIf { it.isNotBlank() }
                val tagged = items.map { it.copy(re = re?.take(400), at = t) }
                // Not walked: a reply to TJ at the laptop (he read it there), or one the conversation has
                // since moved past (a replay of a reply from before the mark).
                val walk = m.optBoolean("walk", true) && t >= movedAt
                if (walk && pending.value.none { p -> tagged.any { it.id == p.id } }) mergeItems(tagged)
                // Start making the voice now, in walk order, so each item is ready before it is reached.
                if (walk) pending.value.forEach { voiceOnPhone(it.id, first = false) }
                if (walk) onReply?.invoke()
            }
            "prompt" -> {
                val id = m.optString("turn").ifEmpty { m.optString("id") }
                if (lines.value.none { it.id == id }) lines.update { it + Line(id, Who.LAPTOP_PROMPT, m.optString("text"), t) }
            }
            // TJ talked to the Assistant away from the phone: everything pending from before then is past.
            "moved" -> {
                val at = m.optLong("at")
                if (at > movedAt) { movedAt = at; prefs.edit().putLong("movedAt", at).apply() }
                dropPast()
            }
            "grid" -> {
                grid.value = parseGrid(m)
                gridAt.value = System.currentTimeMillis()
            }
            "status" -> {
                projects.value = parseProjects(m.optJSONArray("projects") ?: JSONArray())
                statusAt.value = System.currentTimeMillis()
            }
            "sprint" -> if (m.optString("of") == sprintAsk) {
                sprint.value = parseSprint(m.optJSONObject("report") ?: JSONObject())
                sprintLoading.value = false
            }
            // Kept, marked not sent, with Retry: a message is never thrown away. A failed report says so on the Status tab.
            "error" -> if (backup.owns(m.optString("of"))) {
                backup.failed(m.optString("text").ifEmpty { "The backup could not be made." })
            } else if (m.optString("of") == sprintAsk && sprintAsk != null) {
                sprintError.value = m.optString("text").ifEmpty { "The report could not be built." }
                sprintLoading.value = false
            } else fail(m.optString("of"), m.optString("text").ifEmpty { "That did not get through." })
        }
    }

    private fun parseGrid(m: JSONObject): Grid {
        fun str(o: JSONObject, k: String) = o.optString(k).takeIf { it.isNotEmpty() && it != "null" }
        val ps = m.optJSONArray("projects") ?: JSONArray()
        return Grid(m.optString("mac").ifEmpty { "open" }, (0 until ps.length()).map { i ->
            val p = ps.getJSONObject(i)
            val ss = p.optJSONArray("sessions") ?: JSONArray()
            GridProject(p.optString("id"), p.optString("name"), p.optBoolean("hub"), str(p, "attention"), (0 until ss.length()).map { j ->
                val x = ss.getJSONObject(j)
                val st = x.optJSONObject("status") ?: JSONObject()
                val w = x.optJSONObject("wait")
                val g = x.optJSONObject("goal")
                GridSession(
                    x.optString("key"), x.optString("title"), x.optBoolean("running", true), x.optBoolean("assistant"),
                    str(x, "attention"), str(x, "phase"),
                    w?.let { GridWait(it.optString("state"), it.optString("gist"), it.optString("headline"), it.optDouble("since").toLong()) },
                    st.optString("kind"), st.optString("headline"), str(st, "task"), str(st, "taskStatus"), str(st, "detail"), str(st, "waitState"),
                    x.optInt("more"), g?.let { SessionGoal(it.optString("title"), it.optInt("done"), it.optInt("total")) }, x.optInt("questions"),
                )
            })
        }, m.optDouble("at", 0.0).toLong())
    }

    private fun parseSprint(r: JSONObject): SprintReport {
        fun arr(o: JSONObject, k: String) = o.optJSONArray(k) ?: JSONArray()
        fun objs(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it) }
        val range = r.optJSONObject("range") ?: JSONObject()
        val totals = r.optJSONObject("totals") ?: JSONObject()
        val reset = r.optJSONObject("reset") ?: JSONObject()
        return SprintReport(
            label = range.optString("label"), kind = range.optString("kind", "sprint"), current = range.optBoolean("current"),
            tasks = totals.optInt("tasks"), goals = totals.optInt("goals"),
            resetText = reset.optString("text"), confirmed = reset.optBoolean("confirmed"),
            projects = objs(arr(r, "projects")).map { p ->
                SprintProject(p.optString("name"),
                    objs(arr(p, "tasks")).map { t -> SprintTask(t.optString("name"), t.optString("title"), t.optString("closed"), t.optJSONObject("goal")?.optString("name")) },
                    objs(arr(p, "goals_done")).map { g -> SprintGoal(g.optString("name"), g.optString("title"), g.optString("completed_at")) })
            },
            sprints = objs(arr(r, "sprints")).map { x -> SprintRef(x.optString("id"), x.optString("label"), x.optInt("offset"), x.optInt("done")) },
        )
    }

    private fun parseProjects(a: JSONArray): List<Project> = (0 until a.length()).map { i ->
        val p = a.getJSONObject(i)
        val s = p.optJSONArray("sessions") ?: JSONArray()
        val gs = p.optJSONArray("goals") ?: JSONArray()
        fun str(o: JSONObject, k: String) = o.optString(k).takeIf { it.isNotEmpty() && it != "null" }
        Project(
            name = p.optString("name"),
            goals = (0 until gs.length()).map { j ->
                val g = gs.getJSONObject(j)
                val ts = g.optJSONArray("tasks") ?: JSONArray()
                GoalTasks(g.optString("title"), g.optInt("done"), g.optInt("total"), (0 until ts.length()).map { k ->
                    val t = ts.getJSONObject(k)
                    TaskItem(t.optString("title"), t.optString("status"), t.optString("proof"), str(t, "latest"), t.optString("at"), str(t, "who"), str(t, "name"))
                }, g.optString("status").ifEmpty { "active" })
            },
            sessions = (0 until s.length()).map { j ->
                val x = s.getJSONObject(j)
                val g = x.optJSONObject("goal")
                val w = x.optJSONObject("work")
                Session(x.optString("name"), x.optString("state"), x.optString("said"), str(x, "task"),
                    title = str(x, "title") ?: x.optString("name"),
                    goal = g?.let { SessionGoal(it.optString("title"), it.optInt("done"), it.optInt("total")) },
                    work = w?.let { TaskItem(it.optString("title"), it.optString("status"), it.optString("proof"), str(it, "latest"), it.optString("at"), null, str(it, "name")) })
            },
        )
    }

    override fun onCleared() {
        socket?.close(1000, null)
        http.dispatcher.executorService.shutdown()
    }
}
