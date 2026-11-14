# Session swaps: what was proved, and how

13 November 2026. Every way an agent creates a session was run by real Claude Code agents
(Opus 5.5) inside a built Genlock app, plus the fail-safe for when the app does not answer.

## The mechanism

genlock asks the app for a session by dropping a request file in the session's channel folder
(`swap.json`, `open-*.json`, `spawn-*.json`). Each request now carries an `id`, and the app
answers every one with `receipt-ID.json`: `{ok:true}` once it has opened the session (for a
swap, once it has accepted it for the end of the turn), or `{ok:false, why, code}`.
`lib/appask.mjs` waits up to 8 s for it (`GENLOCK_RECEIPT_MS`).

- **Receipt ok:** the main path. Nothing else happens.
- **Refused at the session cap (`code: cap`):** the agent is told to ask the user for
  `--over-cap`. The fail-safe does not route around the user's cap.
- **Refused for any other reason, or no receipt (app quit, crashed, lost the session):** the
  request is taken back (unlinked) so a late app cannot open it as well, and genlock opens the
  session in a Terminal window itself, with the same opening prompt, in the right project, without
  asking anyone. If AppleScript is refused, `open -a Terminal SCRIPT` is tried. If no window opens
  either, the old session is left running and the agent is handed the command.
- **A handoff closes the old session only once the fresh one is confirmed** (receipt, or the
  fallback window opened). Before this change it wrote `close.json` before knowing.
- An app from before receipts takes the file and writes nothing: counted as opened, so a new
  genlock with an old app does not open sessions twice.

## Real runs (driven app, real agents)

Built app `app/build/Genlock.app`, driven with `GENLOCK_APP_DRIVE` and its own project store,
five throwaway git projects (alpha to epsilon), each with a goal and a task. The messages were
delivered the way the app delivers them (`submit`, the new `submitNth` driver step).

| Path | Condition | What the agent ran | Observed |
|---|---|---|---|
| Swap | project's main session, in a 4-pane split | `genlock start T-9TN3K && genlock swap G-9TSBB` | old conversation under Recently ended (`alpha#+197cb6`); fresh conversation `16ce44ab` in the same tab, opened with the handed task, ran `genlock start T-9TN3K` (owner now `16ce44ab`, `handoff` event on record) and said "The alpha swap test arrived" |
| Swap | a second session of the project (slot), not focused | `genlock swap alpha-test` | `alpha#+7f283a` ended, `alpha#+cc6b55` started on the goal and reported arrival |
| Close | user's words "Great, you can close" | `genlock close --self --user-said "..."` | gamma's tab moved to Recently ended once its turn ended |
| Close-and-spawn | handoff with gaps to fill | `genlock open --handoff` | "A fresh session opened on beta"; `beta` ended, `beta#+d4a34b` took T-T6QGM and proved it |
| New spawn | beside the asker | `genlock open --prompt '...'` | `delta#+6161ec` opened, replied "The open test arrived." |
| New spawn | another project | `genlock open epsilon --prompt '...'` | epsilon session opened, replied "The open test arrived." |
| New spawn | spin-off, on the user's yes | `genlock spinoff launch T-9CTXS --user-said "..."` | `delta#T-9CTXS` opened in a pane and started on its ticket |

## Fail-safe, real Terminal

No app reading the channel (a dead channel folder), the real Terminal route, and
`GENLOCK_CLAUDE_CMD` pointed at a marker script so no real session was left on screen:

- `genlock swap alpha-test`: "the app did not answer within 8s ... taken back"; `swap.json`
  gone, `close.json` written; the window ran in `e2e/alpha` with
  `-n alpha-test Carry on with the goal ... genlock continue G-9TSBB ...`.
- `genlock open --prompt "Say the fail-safe open arrived"`: same, the window ran with that prompt.
  Terminal was slow (one AppleEvent timed out) and the window ran late, but it ran.

## Tests

`tests/receipts.mjs` (17 tests, in `npm test`) plays the app with a second process and covers:
swap acked, swap unanswered (window, close), swap unanswered with no window (stays open),
open ok / cap refusal (no fallback) / other refusal (window) / unanswered (window), open in
another project (window in that project), an app from before receipts, handoff ok / unanswered
with and without a window, spin-off launch unanswered and ok, and the Assistant's open
unanswered and ok.

## What this does not cover

- The driven runs were in throwaway projects under /private/tmp, whose folder-trust prompt had
  to be accepted first (it defaults to "No, exit"). TJ's real projects are already trusted.
- Two of the first run's messages were lost because they were pasted while the session was still
  starting. That is message delivery at session start, not the swap paths; they were re-run with
  a longer settle time and passed.
- If AppleScript times out *after* Terminal queued the window, the `open -a Terminal` retry could
  open a second window. Not observed.
- The phone (TJ asks Tally to swap a session) was not run: assistant-acts req 5 stays TJ's.
