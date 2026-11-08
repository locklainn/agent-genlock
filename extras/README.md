# extras

Unused code kept for later. Nothing in genlock or the app runs these.

## statusline-usage.sh

TJ's old Claude Code status line: the session (5h) and weekly usage bars with reset times and
a weekly pace mark, also logged to `~/.claude/usage-latest.json` and `~/.claude/usage-log.csv`.

Removed from `~/.claude/settings.json` on 2026-11-08 because a status line, even an empty one,
takes a row at the bottom of every session, and the Genlock app shows usage in its own top bar.

To use it again in one project, copy it somewhere stable and add to that project's
`.claude/settings.local.json`:

    { "statusLine": { "type": "command", "command": "bash /path/to/statusline-usage.sh", "refreshInterval": 60 } }

It needs `jq`.
