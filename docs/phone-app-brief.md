# Phone app: starting brief

Written 2026-11-07 when the work was handed to its own session. It records what was
known then; check the code before relying on it.

## What TJ asked for
A native connection between Genlock on the laptop and the phone, with dictation.
"Not a 1-1 port of what genlock ui is. More like a connection back, to remote control,
get status updates. Maybe JUST work with the assistant." Android first, iOS later.

## What exists on the laptop
- macOS SwiftUI app in `app/` (GenlockApp + GenlockCore). It runs Claude Code sessions
  per project in terminal panes, plus one cross-project session, the Assistant (named
  Tally; folder `~/Library/Application Support/Genlock/Assistant`).
- Assistant launch: `SessionLaunch.arguments` in `app/Sources/GenlockCore/Voice.swift`,
  `AppModel.launch` in `app/Sources/GenlockApp/AppModel.swift`.
- Message paths today: per-session channel folders (`VoiceChannel`; `say-*.json` voice
  summaries routed to the Assistant in `AppModel.routeUpdates`), and `genlock tell PROJECT`
  (`lib/overview.mjs` cmdTell) for messages out to project sessions.
- CLI: `bin/genlock.mjs` + `lib/`.

## Parallel work: stay out of these files
Another session is adding a Remote button: it launches the Assistant with
`claude --remote-control` so the official Claude Code phone app can reach it. That is the
stopgap; this app is the real thing. Its files: `app/Sources/GenlockCore/Voice.swift`,
`app/Sources/GenlockApp/AppModel.swift`, `SessionsView.swift`, `TerminalSession.swift`,
`app/Tests/GenlockCoreTests/CoreTests.swift`. Any Mac-side change goes in new files, or
waits until that session releases its claims (`genlock claims`).

## The hard part is getting a connection, not building screens
The laptop sits behind the home router, so the phone cannot reach it directly. Options
raised so far:
- a relay: TJ already runs Cloudflare Workers (e.g. activity-worker.tj-locklainn.workers.dev),
  and a Durable Object relay fits;
- Tailscale.

Also needed: pairing (a one-time trust handshake, e.g. scanning a QR code) and push
notifications for "a session needs you".

## Suggested first steps
1. Open a ticket with its requirements first (`genlock new ... --goal G-R5WR4`).
2. Write `mobile/DESIGN.md`: how to get a connection (with trade-offs), pairing, the message
   protocol, and what the phone shows. Get TJ's OK on how to get a connection before
   building much.
3. Then build the Android app in `mobile/` (Kotlin + Jetpack Compose suggested) and a
   laptop-side bridge.
