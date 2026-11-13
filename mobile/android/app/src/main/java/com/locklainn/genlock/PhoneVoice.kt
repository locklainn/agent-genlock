package com.locklainn.genlock

import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * The Genlock voice made on the phone (TJ, 2026-11-12: "the voices need to be installed on the
 * phone app ... I don't want any transfer of that stuff over the Internet"). The same Kokoro model
 * and sherpa-onnx 1.13.8 the Mac speaks with (lib/voices.mjs), the same sentences and words
 * (VoiceText), so an item sounds the same on either.
 *
 * It fills [clips] exactly as the bridge's clips did, a sentence at a time, so the Walker plays
 * them unchanged. Items are made in walk order; the item being heard is moved to the front, and
 * the worker switches to it between sentences.
 */
class PhoneVoice(private val model: VoiceModel, private val clips: Clips, private val log: (String) -> Unit = {}) {
    /** A project's voice: speakers and weights summing to 1, and a speed. As lib/speaker.mjs voiceFor gives it. */
    data class Voice(val parts: List<Pair<String, Double>>, val speed: Double = 1.0) {
        val accent: String get() = if (parts.sortedByDescending { it.second }.first().first.startsWith("b")) "gb" else "us"
        val engineKey: String get() = if (parts.size == 1) "table:$accent" else "blend:" + parts.joinToString(",") { "${it.first}:${it.second}" }
        companion object {
            /** The hub's default (lib/speaker.mjs hubVoice), for text from no known project. */
            val DEFAULT = Voice(listOf("af_heart" to 1.0))
        }
    }

    private class Job(val id: String, val text: String, val voice: Voice) {
        var said: List<String>? = null
        var i = 0
    }

    private val lock = Object()
    private val queue = ArrayList<Job>()
    private var worker: Thread? = null

    fun ready() = model.ready()

    /**
     * Voice [text] as clip item [id], in [voice]. Already made or queued is not made twice;
     * [first] moves it to the front (the Walker is waiting on it).
     */
    fun want(id: String, text: String, voice: Voice, first: Boolean = false) = synchronized(lock) {
        val at = queue.indexOfFirst { it.id == id }
        // Made already and still kept: nothing to do. Clips forgets old items, and then it is made again.
        if (at < 0 && clips.known(id)) return@synchronized
        val job = if (at >= 0) queue.removeAt(at) else Job(id, text, voice)
        if (first) queue.add(0, job) else queue.add(job)
        if (worker == null) worker = Thread(::run, "phone-voice").apply { priority = Thread.MAX_PRIORITY - 1; start() }
        lock.notifyAll()
    }

    private fun run() {
        while (true) {
            val job = synchronized(lock) {
                while (queue.isEmpty()) lock.wait()
                queue[0]
            }
            val more = runCatching { step(job) }.getOrElse { e ->
                log("voice ${job.id}: ${e.message}")
                clips.failed(job.id)
                false
            }
            if (!more) synchronized(lock) { queue.remove(job) }
        }
    }

    /** Make the job's next sentence. False once it is whole. */
    private fun step(job: Job): Boolean {
        if (job.id.startsWith("warm:")) { engine(job.voice); return false }
        val said = job.said ?: VoiceText.sentences(job.text).also { job.said = it }
        if (job.i >= said.size) { clips.done(job.id, said.size); return false }
        val t0 = System.currentTimeMillis()
        val engine = engine(job.voice)
        val sid = if (job.voice.parts.size == 1) SPEAKERS.indexOf(job.voice.parts[0].first) else SPARE
        // lib/voices.mjs makeEngine's generate applies speakable() to each sentence again; so does this.
        val a = engine.generate(VoiceText.speakable(said[job.i]), sid, job.voice.speed.toFloat())
        clips.add(job.id, job.i, said[job.i], wav(a.samples, a.sampleRate), "wav")
        log("voice ${job.id} ${job.i + 1}/${said.size} ${System.currentTimeMillis() - t0}ms for ${"%.1f".format(a.samples.size.toDouble() / a.sampleRate)}s")
        job.i++
        return true
    }

    // ---- engines -------------------------------------------------------------------------------

    /** Loaded engines by [Voice.engineKey], the two most recent kept: each holds the model (~1 GB). */
    private val engines = LinkedHashMap<String, OfflineTts>()

    private fun engine(v: Voice): OfflineTts {
        engines.remove(v.engineKey)?.let { engines[v.engineKey] = it; return it }
        val d = model.dir
        val gb = v.accent == "gb"
        val tts = OfflineTts(null, OfflineTtsConfig(
            model = OfflineTtsModelConfig(
                kokoro = OfflineTtsKokoroModelConfig(
                    model = File(d, "model.onnx").path,
                    voices = if (v.parts.size == 1) File(d, "voices.bin").path else blendTable(v).path,
                    tokens = File(d, "tokens.txt").path,
                    dataDir = File(d, "espeak-ng-data").path,
                    lexicon = File(d, if (gb) "lexicon-gb-en.txt" else "lexicon-us-en.txt").path,
                    // espeak-ng's British English is 'en'; it has no 'en-gb' (lib/voices.mjs).
                    lang = if (gb) "en" else "en-us",
                ),
                // Measured on the Pixel 10 Pro: 6 threads make speech at 0.53-0.58 of its playing time.
                numThreads = 6,
                provider = "cpu",
            ),
            maxNumSentences = 1,
        ))
        engines[v.engineKey] = tts
        while (engines.size > 2) engines.remove(engines.keys.first())?.release()
        return tts
    }

    /** Load the engine a voice needs now, so the first sentence of a walk does not wait on it (~2s). */
    fun warm(v: Voice = Voice.DEFAULT) = synchronized(lock) {
        // Through the queue's worker, so loading never races a sentence being made.
        queue.add(Job("warm:${v.engineKey}:${System.nanoTime()}", "", v))
        if (worker == null) worker = Thread(::run, "phone-voice").apply { priority = Thread.MAX_PRIORITY - 1; start() }
        lock.notifyAll()
    }

    /** A copy of voices.bin with the blend in the spare slot: lib/voices.mjs blendTable, float for float. */
    private fun blendTable(v: Voice): File {
        val id = MessageDigest.getInstance("SHA-256").digest(v.engineKey.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)
        val out = File(model.dir.parentFile, "blends/$id.bin")
        if (out.isFile) return out
        val bytes = File(model.dir, "voices.bin").readBytes()
        val table = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        val mix = FloatArray(STYLE)
        for ((name, w) in v.parts) {
            val base = SPEAKERS.indexOf(name) * STYLE
            for (i in 0 until STYLE) mix[i] = (mix[i].toDouble() + w * table.get(base + i).toDouble()).toFloat()
        }
        for (i in 0 until STYLE) table.put(SPARE * STYLE + i, mix[i])
        out.parentFile?.mkdirs()
        val tmp = File(out.path + ".tmp")
        tmp.writeBytes(bytes)
        tmp.renameTo(out)
        return out
    }

    companion object {
        /** The order of speakers in voices.bin, fixed by the pinned file (lib/voices.mjs SPEAKERS). */
        val SPEAKERS = ("af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky," +
            "am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa," +
            "bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis," +
            "ef_dora,em_alex,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,if_sara,im_nicola," +
            "jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,pf_dora,pm_alex,pm_santa," +
            "zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang,em_santa").split(",")
        private const val STYLE = 510 * 256
        private val SPARE = SPEAKERS.indexOf("em_santa")

        const val LATE = "Came in while we talked."

        /** What is read for an item, less the "came in" line: mobile/bridge/voicing.mjs spokenOf. */
        fun spokenOf(item: Item): String {
            val head = listOf(item.project, item.task).filter { it.isNotBlank() }.joinToString(", ")
            return listOfNotNull(if (head.isNotEmpty()) "$head." else null, item.say.ifEmpty { null }, item.ask?.ifEmpty { null })
                .joinToString(" ").replace(Regex("[*`#_]"), "")
        }

        /** {parts:[[name,weight],...], speed} from the bridge. Null if it names no voice this model has. */
        fun voiceOf(o: org.json.JSONObject?): Voice? {
            val a = o?.optJSONArray("parts") ?: return null
            val parts = (0 until a.length()).mapNotNull { i ->
                a.optJSONArray(i)?.let { p -> p.optString(0) to p.optDouble(1, 1.0) }?.takeIf { it.first in SPEAKERS }
            }
            if (parts.isEmpty() || parts.size != a.length()) return null
            return Voice(parts, o.optDouble("speed", 1.0).takeIf { it > 0 } ?: 1.0)
        }

        /** 16-bit mono PCM WAV: lib/voices.mjs wavBytes. */
        fun wav(samples: FloatArray, rate: Int): ByteArray {
            val b = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            b.put("RIFF".toByteArray()).putInt(36 + samples.size * 2).put("WAVE".toByteArray())
            b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
            b.put("data".toByteArray()).putInt(samples.size * 2)
            for (s in samples) b.putShort(Math.round(s.coerceIn(-1f, 1f) * 32767.0).toInt().toShort())
            return b.array()
        }
    }
}
