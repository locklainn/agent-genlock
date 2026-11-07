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

enum class Who { ME, LAPTOP_PROMPT, ASSISTANT, NOTE }

data class Line(val id: String, val who: Who, val text: String, val t: Long, val pending: Boolean = false)

data class Session(val name: String, val state: String, val said: String, val task: String?)

data class Project(
    val name: String,
    val sessions: List<Session>,
    val topGoal: String?,
    val topTask: String?,
    val openTasks: Int,
    val waiting: List<String>,
    val blocked: Int,
    val due: List<String>,
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
        if (wantOpen) open()
    }

    fun unpair() {
        prefs.edit().clear().apply()
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

    fun say(text: String) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        if (conn.value != Conn.CONNECTED) {
            note("Not connected, so that was not sent.")
            return
        }
        val id = send(JSONObject().put("kind", "say").put("text", clean))
        lines.update { it + Line(id, Who.ME, clean, System.currentTimeMillis(), pending = true) }
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
                m.optString("assistant").takeIf { it.isNotEmpty() }?.let { assistant.value = it }
                m.optString("assistantName").takeIf { it.isNotEmpty() }?.let {
                    assistantName.value = it
                    prefs.edit().putString("assistantName", it).apply()
                }
                if (m.optString("laptop") == "offline") assistant.value = "unknown"
            }
            "ack" -> {
                val of = m.optString("of")
                lines.update { list -> list.map { if (it.id == of) it.copy(pending = false) else it } }
                seen(t)
            }
            "reply" -> {
                val id = m.optString("turn").ifEmpty { m.optString("id") }
                seen(t)
                if (lines.value.any { it.id == id }) return
                val text = m.optString("text")
                lines.update { it + Line(id, Who.ASSISTANT, text, t) }
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
            "error" -> {
                val of = m.optString("of")
                lines.update { list -> list.filterNot { it.id == of && it.who == Who.ME && it.pending } +
                    Line(UUID.randomUUID().toString(), Who.NOTE, m.optString("text"), t) }
            }
        }
    }

    private fun parseProjects(a: JSONArray): List<Project> = (0 until a.length()).map { i ->
        val p = a.getJSONObject(i)
        val s = p.optJSONArray("sessions") ?: JSONArray()
        val due = p.optJSONArray("due") ?: JSONArray()
        val waiting = p.optJSONArray("waiting") ?: JSONArray()
        Project(
            name = p.optString("name"),
            sessions = (0 until s.length()).map { j ->
                val x = s.getJSONObject(j)
                Session(x.optString("name"), x.optString("state"), x.optString("said"), x.optString("task").takeIf { it.isNotEmpty() && it != "null" })
            },
            topGoal = p.optString("topGoal").takeIf { it.isNotEmpty() && it != "null" },
            topTask = p.optString("topTask").takeIf { it.isNotEmpty() && it != "null" },
            openTasks = p.optInt("openTasks"),
            waiting = (0 until waiting.length()).map { waiting.getString(it) },
            blocked = p.optInt("blocked"),
            due = (0 until due.length()).map { j ->
                val d = due.getJSONObject(j)
                val days = d.optInt("days")
                "${d.optString("title")} — " + when {
                    days < 0 -> "overdue ${-days}d"
                    days == 0 -> "today"
                    else -> "in ${days}d"
                }
            },
        )
    }

    override fun onCleared() {
        socket?.close(1000, null)
        http.dispatcher.executorService.shutdown()
    }
}
