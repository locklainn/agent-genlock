# Genlock phone app: design

Ticket T-GBCR9 (phone app), goal G-R5WR4. Written 2026-11-07. This doc covers the first
working build: talk to the Assistant by dictation, and get status updates from the laptop.
It is not a port of the Mac app.

## 1. What the phone does (first build)

Three screens:

1. **Talk.** A chat with the Assistant (Tally). There is one big mic button that uses
   Android's own speech recognizer, so there are no extra costs. You can edit the
   transcript before you send it, or set it to send on its own when you stop talking.
   The Assistant's replies come back as text, and the phone can read them aloud with
   Android text-to-speech.
2. **Status.** Every project and its open sessions, with the task each one is on, what
   needs you, and what is due. It is pulled from the laptop on demand and when the app
   opens. Tapping a project drafts "what's happening in X?" into Talk.
3. **Pair.** Shown once: scan the QR code the laptop shows.

What it leaves out for now, on purpose: driving project sessions directly, terminal
views and editing files. Those all go through the Assistant, which matches the decision
already recorded on the remote-hub goal: relay through the Assistant before reaching
each session directly.

## 2. The laptop side needs no Swift changes

I checked the code. The pieces are already there:

| need | what exists | where |
|---|---|---|
| put a message into the Assistant | a `tell-*.json` file dropped in a session's channel folder is typed into that session's prompt, and this covers every running session, the Assistant included | `VoiceChannel.takeTells` in `Voice.swift:470`, `AppModel.collectTells` in `AppModel.swift:977` |
| find the Assistant's channel | in `sessions.json`, the `open` entry whose `project` is `…/Genlock/Assistant` has a `token`; the channel is `…/Genlock/voice/<token>/` | `~/Library/Application Support/Genlock/` |
| read the Assistant's replies | Claude Code writes its transcript as JSONL; lines with `type: "assistant"` carry the reply text | `~/.claude/projects/-Users-tj-Library-Application-Support-Genlock-Assistant/<conversation>.jsonl`, where the conversation id is in `sessions.json` → `conversations` |
| status across projects | `genlock overview`, run with `GENLOCK_APP_PROJECTS` and `GENLOCK_APP_CHANNELS` set | `lib/overview.mjs` cmdOverview |

So the **bridge** is a small Node process in `mobile/bridge/`, outside the Mac app and
outside the files T-STRBH holds. It:

- writes the phone's message as `tell-<ms>-<rand>.json` into the Assistant's channel, with
  a `[phone]` prefix so the Assistant knows to answer briefly and in plain words;
- follows the Assistant's transcript and sends each new reply back to the phone;
- answers status requests by running `genlock overview`, in a structured form (a `--json`
  flag on overview, or the bridge parsing it, to be decided when building);
- re-reads `sessions.json` whenever the Assistant restarts or swaps, because the token
  and conversation id change.

Limits: the Mac app has to be running with the Assistant open, and the laptop has to be
awake. If it isn't, the phone says so ("laptop offline" or "Assistant not open").
Opening it from the phone can come later, with T-46N3P (open-from-hub).

Later, the bridge can move into the Mac app as a Swift `PhoneBridge.swift` once
T-STRBH's claims are released. Node gets it working now without waiting on them.

## 3. How the phone reaches the laptop (your decision)

The laptop sits behind the home router, so the phone can't connect to it directly. Both
sides have to reach something they can both get to.

### Option A: Cloudflare relay (recommended)

A Worker plus one Durable Object per pairing. The bridge and the phone each open an
**outbound** WebSocket to it, and it passes frames between them. (A Durable Object is a
single stateful instance with a stable address, so both ends of a pairing always land
on the same one.)

- **For:** works from anywhere, on any network, with nothing to install but the app.
  You already run Workers (`activity-worker`). It's free at this volume: a few hundred
  messages a day is far under the free tier, and WebSocket hibernation keeps idle
  connections from being billed. It's also where push notifications plug in later
  (section 6).
- **Against:** messages pass through Cloudflare. Mitigation: encrypt each message end to
  end with a key that only lives on the laptop and the phone, exchanged in the QR code,
  so the relay only ever sees ciphertext. It's one more thing to deploy, and it needs
  `wrangler`, which isn't installed yet (`npm i -g wrangler`, then `wrangler login`).

### Option B: Tailscale

A private network between your devices, so the phone calls the bridge directly at
`http://<laptop>.ts.net:port`.

- **For:** the least code, since there's no server to write. Traffic is encrypted and
  never stored anywhere.
- **Against:** the Tailscale app has to be installed and running on both devices. On
  Android it takes the single VPN slot, so it clashes with any other VPN you use. Push
  notifications still need a server.

### Option C: same Wi-Fi only

The phone finds the bridge on the home network. It's fine for a first test, but it does
nothing once you leave the house, which is the point of the app.

**Recommendation: A.** It's the only option that works anywhere with nothing to install,
and push needs that server anyway. I'd build C's direct connection as a debug mode, so
the app and bridge can be tested before the relay is deployed.

## 4. Pairing

1. `node mobile/bridge/pair.mjs` on the laptop creates a pairing: a random `room` id (128
   bits), a `secret` (256 bits) and the relay URL. It saves them in
   `~/Library/Application Support/Genlock/phone/pairing.json` (mode 600), then prints a
   QR code in the terminal.
2. The phone scans the QR code and stores the same three values in Android's encrypted
   storage (EncryptedSharedPreferences / Keystore).
3. Each side proves itself to the relay with `HMAC(secret, "<role>:<timestamp>")` on
   connect. The relay holds only a hash of the auth key, set up on first connect, and
   refuses anything that doesn't match. A client with no pairing, or with the wrong one,
   gets `401` and is disconnected.
4. To unpair, run `pair.mjs --revoke`, which deletes the room. A new QR code replaces the
   old pairing.

Message encryption (optional for the first build, cheap to add): XChaCha20-Poly1305
with a key derived from `secret`, using libsodium on both sides.

## 5. Messages

JSON over the WebSocket. Every message has `id` (a uuid), `t` (ms epoch) and `kind`.

Phone → laptop:
```
{ kind: "say",    text: "..." }               // into the Assistant's prompt
{ kind: "status" }                            // ask for a status snapshot
{ kind: "hello",  lastSeen: <t> }             // on connect; the bridge resends replies after lastSeen
```
Laptop → phone:
```
{ kind: "ack",    of: <id> }                  // typed into the Assistant
{ kind: "reply",  text: "...", turn: <uuid> } // an Assistant reply, from the transcript
{ kind: "status", projects: [ { name, sessions: [ { name, task, phase, needsYou } ], due: [...] } ] }
{ kind: "state",  laptop: "online", assistant: "open"|"closed"|"busy" }
{ kind: "error",  of: <id>, text: "..." }
```
The relay keeps the last 50 laptop → phone messages per room, so a phone that was
offline catches up on reconnect.

## 6. Push notifications (after the first build)

When a session needs you, or the Assistant replies while the app is closed, the relay
sends a Firebase Cloud Messaging push. That needs a Firebase project and a server key
stored in the Worker. It's left out of the first build, so the app only shows what
arrives while it's open.

## 7. Layout

```
mobile/
  DESIGN.md
  android/      Kotlin + Jetpack Compose, minSdk 26; OkHttp WebSocket, ML Kit barcode
                scanning for the QR, SpeechRecognizer, TextToSpeech
  bridge/       Node 20, no build step: bridge.mjs, pair.mjs, test/
  relay/        Cloudflare Worker + Durable Object (Option A only)
```

## 8. Build order

1. Bridge, using the direct (LAN) mode, with a test: a fake phone sends `say` → a
   `tell-*.json` appears in a temporary channel folder; a line added to a temporary
   transcript → a `reply` comes out. A client with no token is refused.
2. Android app against the LAN bridge: pair, talk and status. Then a debug APK onto your
   phone.
3. The relay: deploy it, then switch both sides over to it.
4. Your check on the phone: dictate, hear Tally's reply, look at the status.
