package com.locklainn.genlock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Keeps listening to the relay while the app is in the background, and posts a notification for
 * each new Assistant reply that arrives while the app is out of sight. MainActivity starts it in
 * onStart, because Android only lets a visible app start a foreground service, and it keeps running
 * while the phone is paired. While the app is visible it hangs up, because the relay keeps one phone
 * connection per room and a second one would knock Link's off (and Link's would knock it off again).
 *
 * It never writes "lastSeen" (Link's replay point), so replies it notified about still replay into
 * the chat when the app opens. It keeps its own "notifiedUpTo" so a reconnect does not notify twice.
 */
class Watch : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var retryMs = 2000L
    private var running = false
    private val link get() = getSharedPreferences("genlock", Context.MODE_PRIVATE)
    private val mine get() = getSharedPreferences("genlock-watch", Context.MODE_PRIVATE)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels(this)
        val quiet = Notification.Builder(this, QUIET)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle("Listening for the Assistant")
            .setContentText("You get a notification when it has something to tell you.")
            .setContentIntent(openApp(this, 0))
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, quiet, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(1, quiet)
        // Start from where the chat last read, so the first connection does not notify old replies.
        val seen = link.getLong("lastSeen", 0)
        if (mine.getLong("notifiedUpTo", 0) < seen) mine.edit().putLong("notifiedUpTo", seen).apply()
        running = true
        current = this
        if (!visible) connect()
    }

    /** The app came on screen: Link takes the room's one phone connection. */
    private fun pause() {
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "app open")
        socket = null
    }

    /** The app left the screen: whatever the chat already showed counts as notified, then listen again. */
    private fun resume() {
        val seen = link.getLong("lastSeen", 0)
        if (mine.getLong("notifiedUpTo", 0) < seen) mine.edit().putLong("notifiedUpTo", seen).apply()
        retryMs = 2000
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY

    override fun onDestroy() {
        running = false
        if (current === this) current = null
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "foreground")
        socket = null
        http.dispatcher.executorService.shutdown()
        super.onDestroy()
    }

    private fun connect() {
        if (!running || socket != null || visible) return
        val relay = link.getString("relay", null)
        val room = link.getString("room", null)
        val key = link.getString("key", null)
        if (relay == null || room == null || key == null) { stopSelf(); return }
        socket = http.newWebSocket(Request.Builder().url(Pairing(relay, room, key).socketUrl()).build(), object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                retryMs = 2000
                ws.send(JSONObject().put("kind", "hello").put("lastSeen", mine.getLong("notifiedUpTo", 0))
                    .put("t", System.currentTimeMillis()).put("id", "watch-" + System.currentTimeMillis()).toString())
            }
            override fun onMessage(ws: WebSocket, text: String) = main.post { receive(text) }.let { }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(1000, null) }
            override fun onClosed(ws: WebSocket, code: Int, reason: String) = main.post { dropped(ws, code) }.let { }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = main.post { dropped(ws, response?.code) }.let { }
        })
    }

    private fun dropped(ws: WebSocket, code: Int?) {
        if (socket !== ws) return
        socket = null
        if (code == 401) { stopSelf(); return }   // unpaired: nothing to listen to
        main.postDelayed(::connect, retryMs)
        retryMs = (retryMs * 2).coerceAtMost(60_000)
    }

    private fun receive(raw: String) {
        val m = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val kind = m.optString("kind")
        // A file is kept for the app to fetch when it opens (the bridge replays it); here it only notifies, once.
        val isFile = kind == "file" && m.optInt("seq", -1) == 0
        if (kind != "reply" && !isFile) return
        val t = m.optLong("t", 0)
        if (t != 0L && t <= mine.getLong("notifiedUpTo", 0)) return
        if (t != 0L) mine.edit().putLong("notifiedUpTo", t).apply()
        if (visible) return
        val text = if (isFile) m.optString("caption").ifEmpty { if (m.optString("mime").startsWith("image/")) "Sent you an image" else "Sent you ${m.optString("name")}" }
                   else m.optString("text")
        notifyReply(this, link.getString("assistantName", null) ?: "Assistant", text, t)
    }

    companion object {
        /** MainActivity instances between onStart and onStop. A count, not a flag: opening a link starts
         *  a new instance before the old one stops, and a flag would end up false with the app on screen. */
        private val started = java.util.concurrent.atomic.AtomicInteger(0)
        val visible get() = started.get() > 0
        @Volatile private var current: Watch? = null
        fun shown() { if (started.incrementAndGet() == 1) current?.let { w -> w.main.post { w.pause() } } }
        fun hidden() {
            // Posted, so Link's lastSeen from a reply that just arrived is written before resume reads it.
            if (started.updateAndGet { (it - 1).coerceAtLeast(0) } == 0) current?.let { w -> w.main.postDelayed({ if (!visible) w.resume() }, 500) }
        }
        const val QUIET = "listening"
        const val REPLIES = "replies"

        fun channels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(REPLIES, "Assistant replies", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "When the Assistant has something to tell you" })
            nm.createNotificationChannel(NotificationChannel(QUIET, "Listening in the background", NotificationManager.IMPORTANCE_MIN)
                .apply { description = "Keeps the connection open so replies can reach you"; setShowBadge(false) })
        }

        fun openApp(ctx: Context, code: Int): PendingIntent = PendingIntent.getActivity(
            ctx, code, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("tab", 0),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        fun notifyReply(ctx: Context, name: String, text: String, t: Long) {
            val clean = text.replace(Regex("[*`#_]"), "").trim()
            val n = Notification.Builder(ctx, REPLIES)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(name)
                .setContentText(clean.lineSequence().firstOrNull { it.isNotBlank() } ?: clean)
                .setStyle(Notification.BigTextStyle().bigText(clean))
                .setContentIntent(openApp(ctx, 1))
                .setAutoCancel(true)
                .apply { if (t != 0L) setWhen(t).setShowWhen(true) }
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify((t % Int.MAX_VALUE).toInt().coerceAtLeast(2), n)
        }

        fun start(ctx: Context) {
            if (ctx.getSharedPreferences("genlock", Context.MODE_PRIVATE).getString("room", null) == null) return
            runCatching { ctx.startForegroundService(Intent(ctx, Watch::class.java)) }
        }

        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, Watch::class.java)) }
    }
}
