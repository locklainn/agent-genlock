package com.locklainn.genlock

/**
 * What the Genlock voice says for a piece of text, and where it breaks it into sentences: a port
 * of lib/voices.mjs speakable(), numberWords() and sentences(). The phone and the Mac must cut and
 * read text the same way, or the same reply sounds different on each; VoiceTextTest checks this
 * against fixtures the JavaScript wrote (test/resources/voice-text.json).
 *
 * Regex differences from JavaScript are spelled out: JS `\s` includes Unicode spaces and Java's
 * does not, so [WS] stands in for it.
 */
object VoiceText {
    private const val WS = "[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"

    private val ONES = listOf("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
        "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen")
    private val TENS = listOf("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")

    fun numberWords(n: Long): String {
        if (n < 20) return ONES[n.toInt()]
        if (n < 100) return TENS[(n / 10).toInt()] + if (n % 10 != 0L) "-${ONES[(n % 10).toInt()]}" else ""
        if (n < 1000) return "${ONES[(n / 100).toInt()]} hundred" + if (n % 100 != 0L) " ${numberWords(n % 100)}" else ""
        for ((size, word) in listOf(1_000_000_000L to "billion", 1_000_000L to "million", 1_000L to "thousand")) {
            if (n >= size) return "${numberWords(n / size)} $word" + if (n % size != 0L) " ${numberWords(n % size)}" else ""
        }
        return n.toString()
    }

    private val fence = Regex("```[\\s\\S]*?```")
    private val arrow = Regex("$WS*(->|→)$WS*")
    private val marks = Regex("[`*_#>|]")
    private val thousands = Regex("(\\d),(?=\\d{3}\\b)")
    private val letterDigit = Regex("([A-Za-z])(\\d)")
    private val version = Regex("\\d+(?:\\.\\d+){2,}")
    private val decimal = Regex("(\\d+)\\.(\\d+)")
    private val digits = Regex("\\d+")
    private val spaces = Regex("$WS+")

    fun speakable(text: String): String = text
        .replace(fence, " ")
        .replace(arrow, " to ")
        .replace(marks, " ")
        .replace(thousands, "$1")
        .replace("%", " percent")
        .replace(letterDigit, "$1 $2")
        .replace(version) { m -> m.value.split('.').joinToString(" point ") { numberWords(it.toLong()) } }
        .replace(decimal) { m ->
            numberWords(m.groupValues[1].toLong()) + " point " + m.groupValues[2].map { ONES[it - '0'] }.joinToString(" ")
        }
        .replace(digits) { m ->
            val d = m.value
            if (d.length > 12) d.map { ONES[it - '0'] }.joinToString(" ") else numberWords(d.toLong())
        }
        .replace(spaces, " ")
        .trim(*WS_CHARS)

    // JS String.trim() trims Unicode whitespace and line terminators.
    private val WS_CHARS = charArrayOf(' ', '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ',
        ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
        ' ', ' ', '　', '﻿')

    private val paraBreak = Regex("\\n$WS*\\n|\\n(?=$WS*[-*\\d]+[.)]?$WS)")
    private val bullet = Regex("^$WS*(?:[-*+]|\\d+[.)])$WS+", RegexOption.MULTILINE)
    private val sentenceEnd = Regex("(?<=[.!?…])[\"')\\]]?$WS+(?=[A-Z\"'(\\[])")
    private val letter = Regex("[A-Za-z]")
    private val clause = Regex("(?<=[,;:])$WS+")

    /** Sentences to speak one at a time, the Mac's way: spoken form first, so "12.5" is not cut at its point. */
    fun sentences(text: String): List<String> {
        val out = mutableListOf<String>()
        for (para in text.replace(fence, " ").split(paraBreak)) {
            val said = speakable(para.replace(bullet, ""))
            if (said.isEmpty()) continue
            for (s in said.split(sentenceEnd)) if (letter.containsMatchIn(s)) out.add(s.trim(*WS_CHARS))
        }
        // A very long sentence is cut at a comma or semicolon so the first clip is not slow to arrive.
        return out.flatMap { s ->
            if (s.length <= 220) listOf(s) else s.split(clause).fold(mutableListOf<String>()) { acc, p ->
                if (acc.isNotEmpty() && acc.last().length + p.length < 200) acc[acc.size - 1] = acc.last() + " " + p else acc.add(p)
                acc
            }
        }
    }
}
