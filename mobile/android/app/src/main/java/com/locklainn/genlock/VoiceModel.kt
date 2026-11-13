package com.locklainn.genlock

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * The Genlock voice's model files on the phone: the same Kokoro files the Mac speaks with, pinned
 * by sha256 in assets/voice-model.json (written by mobile/voice_upload.sh). They are downloaded
 * once from our own R2 link and kept in the app's files folder, which survives app updates, so
 * only the model ever travels and never any speech (TJ, 2026-11-12).
 *
 * Every piece is checked against its pin; a piece that does not match is thrown away, never used,
 * because a different file is a different voice. A download cut off part-way resumes where it
 * stopped. It waits for an unmetered network (Wi-Fi): it is ~385 MB.
 */
class VoiceModel(private val ctx: Context) {
    sealed class State {
        object Checking : State()
        /** On a metered network: waiting for Wi-Fi before taking ~385 MB. */
        object WaitingForWifi : State()
        data class Downloading(val done: Long, val total: Long) : State()
        object Ready : State()
        data class Failed(val why: String) : State()
    }

    val state = MutableStateFlow<State>(State.Checking)

    private val manifest = JSONObject(ctx.assets.open("voice-model.json").bufferedReader().readText())
    val model: String = manifest.getString("model")
    /** Kept across app updates: filesDir is the app's own and is not cleared by an install over it. */
    val dir = File(ctx.filesDir, "voice/$model")
    private val partsDir = File(dir.parentFile, "$model.parts")
    /** Written last, holding every pin: present and equal means every file was checked. */
    private val marker = File(dir, ".verified")
    private val pins: String = (0 until manifest.getJSONArray("files").length())
        .joinToString("\n") { manifest.getJSONArray("files").getJSONObject(it).let { f -> "${f.getString("name")} ${f.getString("sha256")}" } }

    fun ready() = marker.isFile && marker.readText() == pins

    private val http = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
    @Volatile private var running = false

    /** Make sure the model is here: returns at once; [state] says how it goes. Safe to call again. */
    @Synchronized fun ensure() {
        if (ready()) { state.value = State.Ready; return }
        if (running) return
        running = true
        Thread({
            try { fetch() } catch (e: Exception) { state.value = State.Failed(e.message ?: e.javaClass.simpleName) }
            finally { running = false }
        }, "voice-model").start()
    }

    private fun metered(): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return true
        return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun fetch() {
        val files = manifest.getJSONArray("files").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
        val parts = files.flatMap { f -> f.getJSONArray("parts").let { a -> (0 until a.length()).map { a.getJSONObject(it) } } }
        val total = parts.sumOf { it.getLong("size") }
        while (metered()) { state.value = State.WaitingForWifi; Thread.sleep(30_000) }
        dir.mkdirs(); partsDir.mkdirs()
        var before = 0L
        for (p in parts) {
            val size = p.getLong("size")
            val f = File(partsDir, p.getString("path"))
            if (!(f.length() == size && sha256(f) == p.getString("sha256"))) {
                download(manifest.getString("base") + p.getString("path"), f, size) { state.value = State.Downloading(before + it, total) }
                val got = sha256(f)
                if (got != p.getString("sha256")) { f.delete(); throw IllegalStateException("${p.getString("path")} did not match its pin (got ${got.take(12)}..)") }
            }
            before += size
            state.value = State.Downloading(before, total)
        }
        state.value = State.Checking
        for (f in files) assemble(f)
        marker.writeText(pins)
        partsDir.deleteRecursively()
        state.value = State.Ready
    }

    /** Join a file's parts into place, or unpack its zip, and check the whole against its pin. */
    private fun assemble(f: JSONObject) {
        val name = f.getString("name")
        val want = f.getString("sha256")
        val pieces = f.getJSONArray("parts").let { a -> (0 until a.length()).map { File(partsDir, a.getJSONObject(it).getString("path")) } }
        val out = File(dir, name)
        if (f.optBoolean("unzip")) {
            if (sha256(pieces.single()) != want) throw IllegalStateException("$name did not match its pin")
            val tmp = File(dir, "$name.tmp").apply { deleteRecursively(); mkdirs() }
            ZipInputStream(pieces.single().inputStream().buffered()).use { z ->
                generateSequence { z.nextEntry }.forEach { e ->
                    // espeak-ng-data/x/y in the zip lands at <dir>/espeak-ng-data/x/y.
                    val rel = e.name.removePrefix("$name/")
                    val target = File(tmp, rel).canonicalFile
                    if (!target.path.startsWith(tmp.canonicalPath + File.separator)) throw IllegalStateException("zip entry outside its folder: ${e.name}")
                    if (e.isDirectory) target.mkdirs() else { target.parentFile?.mkdirs(); FileOutputStream(target).use { z.copyTo(it) } }
                }
            }
            out.deleteRecursively()
            if (!tmp.renameTo(out)) throw IllegalStateException("could not put $name in place")
            return
        }
        val tmp = File(dir, "$name.tmp")
        FileOutputStream(tmp).use { o -> pieces.forEach { p -> p.inputStream().use { it.copyTo(o) } } }
        val got = sha256(tmp)
        if (got != want) { tmp.delete(); throw IllegalStateException("$name did not match its pin (got ${got.take(12)}..)") }
        out.delete()
        if (!tmp.renameTo(out)) throw IllegalStateException("could not put $name in place")
    }

    /** Download [url] into [to], resuming from what is already there. */
    private fun download(url: String, to: File, size: Long, progress: (Long) -> Unit) {
        var have = to.length().takeIf { it < size } ?: 0L
        if (have == 0L) to.delete()
        val req = Request.Builder().url(url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IllegalStateException("download of ${to.name}: HTTP ${r.code}")
            // A server that ignores Range sends the whole file again: start over.
            val append = have > 0 && r.code == 206
            if (!append) have = 0
            val body = r.body ?: throw IllegalStateException("download of ${to.name}: empty")
            FileOutputStream(to, append).use { o ->
                body.byteStream().use { i ->
                    val buf = ByteArray(1 shl 16)
                    var last = 0L
                    while (true) {
                        val n = i.read(buf); if (n < 0) break
                        o.write(buf, 0, n); have += n
                        if (have - last > (1 shl 20)) { last = have; progress(have) }
                    }
                }
            }
        }
    }

    companion object {
        fun sha256(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { i -> val buf = ByteArray(1 shl 16); while (true) { val n = i.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
