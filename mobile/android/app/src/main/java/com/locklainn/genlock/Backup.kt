package com.locklainn.genlock

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.io.File

/**
 * The Back up button. The phone asks the laptop for a backup; the bridge runs
 * `genlock backup --all` (every project's goals and tasks, one .tar.gz) and sends the archive
 * back as "backup-file" chunks. Once whole it is saved to Downloads/Genlock, where it survives
 * the app being uninstalled, and can be put back on any Mac with `genlock restore`.
 */
class Backup(private val ctx: Context) {
    sealed class State {
        object Idle : State()
        object Working : State()
        data class Saved(val where: String, val caption: String?) : State()
        data class Failed(val why: String) : State()
    }

    val state = MutableStateFlow<State>(State.Idle)
    private var ask: String? = null
    private val assembler = FileAssembler(File(ctx.cacheDir, "backup").apply { mkdirs() })

    fun asked(id: String) { ask = id; state.value = State.Working }

    /** True when an error answers this backup's request. */
    fun owns(of: String?) = of != null && of == ask

    fun failed(why: String) { ask = null; state.value = State.Failed(why) }

    /** A chunk of the archive. The last one saves it, off the main thread. */
    fun chunk(m: JSONObject) {
        if (!owns(m.optString("of"))) return
        val whole = runCatching { assembler.add(m) }.getOrElse { failed(it.message ?: "The backup did not arrive whole."); return } ?: return
        ask = null
        Thread {
            val r = runCatching { save(whole.file, File(m.optString("name", whole.file.name)).name) }
            whole.file.delete()
            state.value = r.fold({ State.Saved(it, whole.caption) }, { State.Failed("Could not save the backup: ${it.message}") })
        }.start()
    }

    /** Copies FILE into Downloads/Genlock as NAME. Returns where it went, as a person would look for it. */
    private fun save(file: File, name: String): String {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/gzip")
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Genlock")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Downloads refused the file")
            resolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            return "Downloads/Genlock/$name"
        }
        // Android 8-9: the app's own Downloads folder, which needs no permission.
        val dir = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Genlock").apply { mkdirs() }
        file.copyTo(File(dir, name), overwrite = true)
        return "${dir.path}/$name"
    }
}
