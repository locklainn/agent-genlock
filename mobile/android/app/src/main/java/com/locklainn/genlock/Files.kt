package com.locklainn.genlock

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

/**
 * Files between the phone and the laptop. They ride the relay in chunks, the same size the
 * laptop's bridge uses (mobile/bridge/files.mjs), and are put back together at the far end.
 */
object Files {
    const val CHUNK = 192 * 1024
    private const val MAX_SIDE = 2048

    fun isImage(mime: String?) = mime?.startsWith("image/") == true

    /** Where files from the laptop are kept, so they are still there after the app restarts. */
    fun receivedDir(ctx: Context) = File(ctx.filesDir, "received").apply { mkdirs() }
    private fun outgoingDir(ctx: Context) = File(ctx.filesDir, "outgoing").apply { mkdirs() }

    /** The messages that carry one file, each ready for Link.send. */
    fun chunks(fid: String, file: File, mime: String): List<org.json.JSONObject> {
        val bytes = file.readBytes()
        val total = maxOf(1, (bytes.size + CHUNK - 1) / CHUNK)
        return (0 until total).map { seq ->
            val from = seq * CHUNK
            val part = bytes.copyOfRange(from, minOf(bytes.size, from + CHUNK))
            org.json.JSONObject().put("kind", "file").put("fid", fid).put("seq", seq).put("total", total)
                .put("name", file.name).put("mime", mime).put("size", bytes.size)
                .put("data", Base64.encodeToString(part, Base64.NO_WRAP))
        }
    }

    /**
     * A picked photo, ready to send: turned the right way up, at most 2048 px on its longer side,
     * as a JPEG. A 12 MP photo goes from ~5 MB to a few hundred KB. Runs off the main thread.
     */
    fun prepareImage(ctx: Context, uri: Uri): File {
        val bitmap: Bitmap = if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { d, info, _ ->
                val (w, h) = info.size.width to info.size.height
                val scale = minOf(1.0, MAX_SIDE.toDouble() / maxOf(w, h))
                d.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val opts = BitmapFactory.Options().apply { inSampleSize = sample(bounds.outWidth, bounds.outHeight, MAX_SIDE) }
            ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
                ?: error("That image could not be read.")
        }
        val out = File(outgoingDir(ctx), "photo-${UUID.randomUUID().toString().take(8)}.jpg")
        out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        return out
    }

    /** A thumbnail-sized decode, so a chat full of images does not hold full-size bitmaps. */
    fun preview(path: String, maxSide: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0) return null
        return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample(bounds.outWidth, bounds.outHeight, maxSide) })
    }

    private fun sample(w: Int, h: Int, max: Int): Int {
        var s = 1
        while (maxOf(w, h) / (s * 2) >= max) s *= 2
        return s
    }

    /** Open it full size in whatever the phone uses for that type (Photos for an image). */
    fun open(ctx: Context, path: String, mime: String?) {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", File(path))
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime ?: "*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try { ctx.startActivity(intent) } catch (_: ActivityNotFoundException) {
            ctx.startActivity(Intent.createChooser(intent, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /**
     * A copy in the phone's Downloads, under its own name, so it outlives the app. Android 10 and up
     * need no permission for this; older phones get the share sheet instead.
     */
    fun saveToDownloads(ctx: Context, path: String, name: String, mime: String?) {
        val type = mime ?: "application/octet-stream"
        if (Build.VERSION.SDK_INT < 29) {
            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", File(path))
            ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Save $name").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
            put(android.provider.MediaStore.Downloads.MIME_TYPE, type)
        }
        val uri = ctx.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("no Downloads")
        ctx.contentResolver.openOutputStream(uri)?.use { out -> File(path).inputStream().use { it.copyTo(out) } } ?: error("no stream")
    }
}

/** Puts a file from the laptop back together. add() returns the saved file once its last chunk is in. */
class FileAssembler(private val dir: File) {
    private class Part(val name: String, val mime: String, var caption: String?, val turn: String?, val total: Int, val t: Long) {
        val chunks = arrayOfNulls<ByteArray>(total)
        var got = 0
    }

    data class Whole(val fid: String, val file: File, val mime: String, val caption: String?, val t: Long)

    private val parts = HashMap<String, Part>()

    fun add(m: org.json.JSONObject): Whole? {
        val fid = m.optString("fid").ifEmpty { return null }
        val seq = m.optInt("seq", -1)
        val total = m.optInt("total", 0)
        if (total < 1 || seq !in 0 until total) return null
        val name = File(m.optString("name", "file")).name.replace(Regex("[^\\w.\\-]+"), "_").ifEmpty { "file" }
        val p = parts.getOrPut(fid) {
            Part(name, m.optString("mime", "application/octet-stream"), m.optString("caption").takeIf { it.isNotEmpty() },
                m.optString("turn").takeIf { it.isNotEmpty() }, total, m.optLong("t", System.currentTimeMillis()))
        }
        // The caption rides on the first chunk, which may not arrive first after a reconnect.
        m.optString("caption").takeIf { it.isNotEmpty() }?.let { p.caption = it }
        val part = p
        if (part.chunks[seq] != null) return null
        part.chunks[seq] = Base64.decode(m.optString("data"), Base64.DEFAULT)
        part.got++
        if (part.got < part.total) return null
        parts.remove(fid)
        val file = File(dir, "${fid.takeLast(12).replace(Regex("[^\\w\\-]"), "")}-${part.name}")
        file.outputStream().use { out -> part.chunks.forEach { out.write(it!!) } }
        return Whole(fid, file, part.mime, part.caption, part.t)
    }
}
