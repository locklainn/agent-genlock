#!/bin/bash
# STATUS LINE: the session (5h) and weekly (7d) usage bars, shown and LOGGED.
#
# Claude Code hands this script a JSON blob on stdin every refresh; it includes
# .rate_limits.five_hour.used_percentage and .rate_limits.seven_day.used_percentage --
# the same numbers /usage prints. TJ, 7 October 2026: "is there NO way to feed usage data
# into an agent without me calling the command?!" This is the way: each CHANGED reading is
# appended to ~/.claude/usage-log.csv (at,five_hour,seven_day,session), which scripts --
# lunenburgbudgets/scripts/backlog_pace.py -- read instead of guessing from dollars.
# Only refreshes while a Claude Code session is open; a reader must treat an old row as
# unknown, never as current.
input=$(cat)
five=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
week=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
sess=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
reset=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
LOG="$HOME/.claude/usage-log.csv"
# ONLY A COMPLETE READING IS LOGGED, and deduplicated PER SESSION. On the first run several
# open sessions reported a weekly figure with no five-hour one (20%, 69%, 72% beside this
# account's 29%) -- whatever they are, they are not a reading of this window, and logging
# them made every session's row look "changed" against the last line of the file.
# FRESHNESS IS THE REFRESH, NOT THE CHANGE. The csv gets a row only when a figure moves, so
# a steady 54% looked five minutes old to the governor. This file is rewritten on EVERY
# refresh (tmp + rename) and its mtime is how old the reading really is.
if [ -n "$five" ] && [ -n "$week" ]; then
  printf '{"at":"%s","five_hour":%s,"seven_day":%s,"five_hour_resets_at":%s,"session":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$five" "$week" "${reset:-null}" "$sess" > "$HOME/.claude/usage-latest.json.tmp" \
    && mv "$HOME/.claude/usage-latest.json.tmp" "$HOME/.claude/usage-latest.json"
fi
if [ -n "$five" ] && [ -n "$week" ]; then
  [ -f "$LOG" ] && head -1 "$LOG" | grep -q five_hour_resets_at || echo "at,five_hour,seven_day,five_hour_resets_at,session" > "$LOG"
  last=$(grep ",$sess\$" "$LOG" | tail -1 | cut -d, -f2,3)
  if [ "$last" != "$five,$week" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$five,$week,$reset,$sess" >> "$LOG"
  fi
fi
# WHEN EACH BAR RESETS, beside it, in local time with the date (TJ, 16 October 2026: "next to
# the limits, can you put the time and date of the session and weekly reset?").
wreset=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null)
when() { [ -n "$1" ] && [ "$1" != null ] && date -r "${1%.*}" '+%a %b %-d %-I:%M%p' | sed 's/AM$/am/;s/PM$/pm/'; }
out=""
[ -n "$five" ] && out="session $(printf '%.0f' "$five")%"
[ -n "$five" ] && [ -n "$(when "$reset")" ] && out="$out (resets $(when "$reset"))"
[ -n "$week" ] && out="$out  ·  weekly $(printf '%.0f' "$week")%"
# THE PACE MARK (TJ, 17 October 2026: "with linear pacing, where SHOULD i be sitting a few days
# in"). The weekly window is the 7 days ending at its reset, so even pace is the share of those
# 7 days already gone. Only when the reset time is known.
if [ -n "$week" ] && [ -n "$wreset" ] && [ "$wreset" != null ]; then
  pace=$(( ( ( $(date +%s) - (${wreset%.*} - 604800) ) * 100 + 302400 ) / 604800 ))
  [ "$pace" -ge 0 ] && [ "$pace" -le 100 ] && out="$out / pace ${pace}%"
fi
[ -n "$week" ] && [ -n "$(when "$wreset")" ] && out="$out (resets $(when "$wreset"))"
echo "${out:-usage: n/a}"
