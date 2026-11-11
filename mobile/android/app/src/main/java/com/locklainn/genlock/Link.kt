package com.locklainn.genlock

import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
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
data class Line(val id: String, val who: Who, val text: String, val t: Long, val pending: Boolean = false, val failed: Boolean = false)

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
    val lines = MutableStateFlow<List<Line>>(emptyList())
    val projects = MutableStateFlow<List<Project>?>(null)
    val statusAt = MutableStateFlow(0L)
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

    /** Each reply as it arrives, for reading aloud. */
    var onReply: ((String) -> Unit)? = null

    private fun loadPairing(): Pairing? {
        val relay = prefs.getString("relay", null) ?: return null
        val room = prefs.getString("room", null) ?: return null
        val key = prefs.getString("key", null) ?: return null
        return Pairing(relay, room, key)
    }

    fun pair(p: Pairing) {
        prefs.edit().putString("relay", p.relay).putString("room", p.room).putString("key", p.key).putLong("lastSeen", 0).apply()
        _pairing.value = p
        socket?.close(1000, "re-paired")
        socket = null
        lines.value = emptyList()
        Watch.stop(getApplication())   // it holds the old room; MainActivity's App restarts it on the new one
        flash.value = "Paired with your laptop"
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
                send(JSONObject().put("kind", "hello").put("lastSeen", prefs.getLong("lastSeen", 0)))
                askStatus()
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
            note("The laptop no longer knows this phone. Pair again.")
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
    fun say(text: String): Boolean {
        val clean = text.trim()
        if (clean.isEmpty()) return true
        if (conn.value != Conn.CONNECTED) {
            flash.value = "Not connected. Your message is still in the box; send it again once connected."
            return false
        }
        val id = send(JSONObject().put("kind", "say").put("text", clean))
        lines.update { it + Line(id, Who.ME, clean, System.currentTimeMillis(), pending = true) }
        // No ack in time (the connection dropped as it went): mark it failed, so it can be retried.
        main.postDelayed({ fail(id, null) }, 20_000L)
        waiting.value = true
        startCued = false
        main.removeCallbacks(giveUp)
        main.postDelayed(giveUp, 15 * 60_000L)
        return true
    }

    /** Send a failed message again. It moves to the bottom, as a new message. */
    fun retry(line: Line) {
        if (conn.value != Conn.CONNECTED) { flash.value = "Not connected yet. Retry once it says ready."; return }
        lines.update { list -> list.filterNot { it.id == line.id && it.who == Who.ME } }
        say(line.text)
    }

    private fun fail(id: String, why: String?) {
        if (lines.value.none { it.id == id && it.who == Who.ME && it.pending }) return
        waiting.value = false
        lines.update { list -> list.map { if (it.id == id && it.who == Who.ME) it.copy(pending = false, failed = true) else it } }
        why?.let { note(it) }
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
                    "${assistantName.value} was not open, so the laptop is starting it with your message.", t) }
                lines.update { list -> list.map { if (it.id == of) it.copy(pending = false) else it } }
                seen(t)
            }
            // The bridge saw the phone's message reach the Assistant's conversation.
            "started" -> cueStarted()
            "reply" -> {
                val id = m.optString("turn").ifEmpty { m.optString("id") }
                seen(t)
                if (lines.value.any { it.id == id }) return
                val text = m.optString("text")
                lines.update { it + Line(id, Who.ASSISTANT, text, t) }
                waiting.value = false
                onReply?.invoke(text)
            }
            "prompt" -> {
                val id = m.optString("turn").ifEmpty { m.optString("id") }
                if (lines.value.none { it.id == id }) lines.update { it + Line(id, Who.LAPTOP_PROMPT, m.optString("text"), t) }
            }
            "status" -> {
                projects.value = parseProjects(m.optJSONArray("projects") ?: JSONArray())
                statusAt.value = System.currentTimeMillis()
            }
            // Kept, marked not sent, with Retry: a message is never thrown away.
            "error" -> fail(m.optString("of"), m.optString("text").ifEmpty { "That did not reach the laptop." })
        }
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
