package com.locklainn.genlock

import java.io.File

/**
 * The Genlock voice's clips for walk items: one short clip per sentence, made on the phone
 * (PhoneVoice, a wav) or, before its model is installed, by the Mac's speaker and sent by the
 * bridge (mobile/bridge/voicing.mjs, an m4a), kept here by item id until played. An item
 * is whole once its `done` arrives; `failed` means none are coming and the built-in voice reads it.
 */
class Clips(private val dir: File, private val keep: Int = 80) {
    data class Clip(val i: Int, val text: String, val file: File)

    private class Entry {
        val clips = sortedMapOf<Int, Clip>()
        var n: Int? = null
        var failed = false
    }

    sealed class Next {
        /** Play this one next. */
        data class Play(val clip: Clip) : Next()
        /** Not here yet: wait. */
        object Wait : Next()
        /** Every clip of the item has been played. */
        object End : Next()
        /** None are coming: use the built-in voice. */
        object Failed : Next()
    }

    private val items = LinkedHashMap<String, Entry>()

    private fun entry(item: String) = items.getOrPut(item) { Entry() }.also {
        while (items.size > keep) {
            val oldest = items.keys.first()
            items.remove(oldest)?.clips?.values?.forEach { c -> c.file.delete() }
        }
    }

    @Synchronized fun add(item: String, i: Int, text: String, audio: ByteArray, ext: String = "m4a") {
        dir.mkdirs()
        val f = File(dir, "${item.replace(Regex("[^\\w.-]+"), "_")}-$i.$ext")
        f.writeBytes(audio)
        entry(item).clips[i] = Clip(i, text, f)
    }

    @Synchronized fun done(item: String, n: Int) { entry(item).n = n }
    @Synchronized fun failed(item: String) { entry(item).failed = true }

    /** Every clip of the item is here, or none are coming. */
    @Synchronized fun whole(item: String) = items[item]?.let { it.failed || (it.n != null && it.clips.size >= it.n!!) } ?: false

    /** Anything at all has been heard about this item, so there is no need to ask for it. */
    @Synchronized fun known(item: String) = items.containsKey(item)

    /** What to do after playing [played] clips of [item]. */
    @Synchronized fun next(item: String, played: Int): Next {
        val e = items[item] ?: return Next.Wait
        e.clips[played]?.let { return Next.Play(it) }
        if (e.n != null && played >= e.n!!) return Next.End
        if (e.failed) return Next.Failed
        return Next.Wait
    }
}
