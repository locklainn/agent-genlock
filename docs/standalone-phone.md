# Standalone phone: design

Ticket T-2FJBG, goal G-NCEHA (standalone-phone). Written 2026-11-13. Design only;
nothing here is built yet.

> **On hold, 2026-11-13.** TJ read this and parked it: *"the phone app cant do much except
> talk, unless theres a backend connected. so i think it has limited utility TBH."*
>
> Without a Mac, the phone has two choices. It can talk (option C), or it can hand the work
> to a backend someone else runs: Anthropic's cloud in option A, the Managed Agents API in
> option B. Either way, real work still needs a backend. "Standalone" only changes whose
> backend that is, so the phone gains little over a remote control for the Mac.
>
> The design is kept for later. If it is picked up again, start from section 4: no option
> has been chosen. Sections 2 and 3 cover the record store and sync, and they stand on their
> own. They are worth reusing for any second device, such as a second Mac or a cloud
> session, because they work with any backend.

TJ's ask: *"i also want to support the phone app of genlock workign entirely on its own,
with no mac backend. i want it to be able to kick off the sessions from there, save all
the task state, etc."*

Today the phone is a remote control. Every message goes phone → relay → the Mac's bridge
→ a `tell-*.json` file → Tally running in a terminal on the Mac (see `mobile/DESIGN.md`).
When the Mac is off, the relay answers "The laptop is offline." (`mobile/relay/src/index.js`).
This design has two problems to solve: **where Claude runs** when there is no Mac, and
**where the records live**.

---

## 1. Where Claude runs without the Mac

Anything that runs Claude Code needs a computer. Remote Control needs "your computer has
to stay on and the `claude` process has to keep running" (code.claude.com/docs/en/remote-control).
So the question is whose computer runs it and who pays for it.

Cost is given two ways, following TJ's own convention (`~/.claude/CLAUDE.md`): **Max-plan**
work counts against the allowance (1% of the week ≈ $5 API-equivalent; one 5-hour window ≈
$37, which is an estimate). **API-key** work is real money on a separate bill.

### Option A: Anthropic's cloud sessions, started through a routine (Max plan)

Claude Code on the web runs each session in a VM that Anthropic hosts. These sessions are
the same kind you can open in the Claude app's Code tab. The phone starts one with an HTTP
call to a **routine trigger**:

```
POST https://api.anthropic.com/v1/claude_code/routines/{trigger_id}/fire
Authorization: Bearer <routine token>
anthropic-beta: experimental-cc-routine-2026-04-01
anthropic-version: 2023-06-01
{ "text": "<what the phone wants done>" }
→ { "claude_code_session_id": "...", "claude_code_session_url": "..." }
```

Setup, done once for each repo: TJ creates a routine at claude.ai/code/routines, called
something like "Genlock: start from phone". Its saved prompt is "treat the fire payload as
the task; run `genlock orient`, then do it under genlock's rules". The token is shown only
once, so it gets pasted into the phone app (or scanned in as a QR code) and kept in the
Android Keystore.

- **Cost:** none beyond the plan. Cloud sessions "count toward your plan's usage limits …
  no separate charge for the cloud VM" (code.claude.com/docs/en/claude-code-on-the-web).
  A cloud session costs what the same session would cost on the Mac. Estimate: a focused
  30-minute task at $5–15 API-equivalent is **~1–3% of the week and ~15–40% of a 5-hour
  window**. These figures are derived from TJ's measured $6/hour for a serial stream, not
  measured on cloud sessions. The binding limit is the window, which the Mac's sessions
  share. Three sessions fired from the phone in parallel fill it about three times as fast.
- **Limits:**
  - 100 API fires per hour per account, and 30 per hour per routine.
  - Each repo has to be on GitHub with the Claude GitHub App connected (agent-genlock already
    is: `github.com/locklainn/agent-genlock`).
  - `/fire` is a **research preview** and "not part of the Claude Platform API surface", so it
    can change without notice.
  - The fire text arrives wrapped as an untrusted `<routine-fire-payload>`, so the routine's
    prompt has to opt in to acting on it.
  - Nothing documented lets the phone send a follow-up message into a running cloud session.
    You follow up in the Claude app's Code tab (the response includes the session URL), or
    with `claude -p --cloud <id>`, which needs a machine.
  - The cloud VM's default network is "Limited", so the session can't reach our relay unless
    the relay's host is added to the environment's allowlist.
- **For:** paid for already; the full Claude Code harness, the same skills and the same
  genlock CLI; nothing to host.
- **Against:** a preview API; one routine per repo to set up by hand; a conversation can't
  continue from inside the Genlock app.

### Option B: Managed Agents, called from the relay (API key, per token)

Anthropic's Managed Agents API (`POST /v1/agents` once, then `sessions.create` for each
run) hosts both the agent loop and a sandbox container. The relay Worker holds the API key.
The phone asks the relay, and the relay creates the session and streams its events back
over the WebSocket the phone already uses.

- **Cost:** real money, billed per token. Sonnet 5.5 costs $2 in / $10 out per million
  tokens; Opus 5.5 costs $4 / $20; Haiku 5.5 costs $0.10 / $0.50. With caching on, a
  30-minute coding task is roughly **$1–5 on Sonnet** and about twice that on Opus. That is
  an estimate, not a measurement. Check the current price page for any container-hour
  charge before committing; I have not confirmed one.
- **Limits:** the API account's rate limits, which are separate from Max. The API is in
  beta. The repo is cloned into the container (git over HTTPS with a token held in a
  **vault**).
- **For:** fully programmatic. The phone can start, follow up, interrupt and stream, all
  inside the Genlock app. It doesn't touch the Max allowance, so it never takes the window
  away from Mac sessions.
- **Against:** a second bill. It is not Claude Code, so genlock's hooks and skills would
  need to be carried over as Agent Skills.

### Option C: Tally on the phone, no code sessions (API key, very cheap)

The phone calls the Messages API directly, with tools that act on its own records:
`create_task`, `met`, `goal next`, `rank`, `ask user`. It can't edit code. It replaces
"talk to Tally" when there is no Mac, and keeps goals and tasks moving by voice.

- **Cost:** Haiku 5.5 at $0.10 / $0.50 per million tokens. A 20k-token turn costs about
  **$0.002**, so a day of use is cents. On Sonnet 5.5 a turn is about $0.05.
- **Limits:** no files, no shell, no git. It is a planner, not a worker.
- **For:** cheap, instant, and works offline from everything except Anthropic.
- **Against:** needs an API key on the phone, or held by the relay.

### Ruled out

- **Remote Control** or a `claude` process anywhere: it needs a machine running, and that
  machine is what we're trying to drop.
- **Self-hosted Claude Agent SDK** (Cloudflare Containers or Sandbox): Anthropic's policy is
  that SDK-built agents use API-key auth, not a claude.ai login
  (code.claude.com/docs/en/agent-sdk/overview). That leaves option B's bill plus our own
  hosting and code.
- **`claude setup-token` in a hosted container:** it can only make model requests (no
  Remote Control), and its terms for hosted use are unstated.
- **Claude Code inside Termux on the phone:** fragile, drains the battery, and the session
  dies when Android kills the app.

### Recommendation: A for work, C for talk

Use **A** for real work: it is already paid for, and the cloud session runs the same genlock
we run on the Mac. Use **C** as the phone's own Tally: it is pennies and gives an instant
spoken answer. Keep **B** as the fallback if `/fire` changes or turns out too limiting,
because it is the only option that gives the Genlock app full control of a session.

---

## 2. Where records live on the phone

**The phone keeps the same events, not a new format.** A genlock record is already a set of
events. `lib/store.mjs` stores each record as one append-only JSONL file. Every event has a
random id `e`, and state comes from replaying the events sorted by `(at, e)`, with
duplicates dropped by `e`. That makes the store a **grow-only set**, which is a CRDT (a
conflict-free replicated data type): two copies merge by taking the union, in any order, as
often as you like, and come out the same. Git already merges it that way
(`records/*.jsonl merge=union`). The phone only has to keep the same events.

**On the phone:** a SQLite table in the app's private storage.

```
events(project TEXT, record TEXT, e TEXT, at TEXT, json TEXT,
       PRIMARY KEY (project, e))
```

`INSERT OR IGNORE` is the union merge. Export writes `records/<id>.jsonl`, byte for byte the
same as the Mac's, which is also what the backup button (T-QWEW6) writes.

**Reading state:** the phone needs the replay logic (goals, tickets, next things, rank).
There are two ways to get it:

1. **Port it to Kotlin**, kept honest by a shared **conformance suite**: fixture JSONL files
   plus the `genlock snapshot` JSON each one should produce. The Node tests and the Kotlin
   tests both run it.
2. **Run genlock's own JS on the phone** in an embedded engine such as QuickJS, with the file
   I/O shimmed. There is one source of truth, but `lib/` uses `node:fs`, `git` and
   `child_process` throughout, so the shim is real work.

I'd take 1 with the suite. The phone needs a read-mostly subset, and the suite catches
drift.

**Writing:** the phone mints events the way `emit()` does: a random 6-byte `e`,
`at = max(now, last event in this record + 1 ms)`, `by = "phone-<install id>"` (or the
cloud session's id), and ids from the same 30-letter alphabet. Random ids mean the Mac and
the phone never collide.

**Not on the phone:** claims, `live/` and `sessions.json`. These are live coordination on one
machine, not records.

---

## 3. Sync with the Mac when both exist

Each event set is a union, so sync only has to move events nobody has seen yet. There are
two paths, and they suit different writers.

### 3a. The relay is the always-on hub (phone ↔ Mac)

The relay's Durable Object gains an event log, stored in its SQLite:

```
phone/Mac → relay   { kind: "events", project, events: [...] }      // push
phone/Mac → relay   { kind: "since", project, cursor }              // pull
relay → phone/Mac   { kind: "events", project, events, cursor }
```

- The relay keeps every event, keyed by `e`, so a duplicate push is a no-op. The cursor is
  the relay's own insert order, not `at`, so a late event from a skewed clock is never
  skipped.
- **Mac side:** the bridge appends events it receives to `.genlock/records/<id>.jsonl` (an
  append, skipped when `e` is already present). It pushes new local lines by tailing those
  files. The records are then committed with the work as usual, so git stays the durable
  home on the Mac.
- **Phone only:** the relay plus the phone are the store, with the backup button for safety.
- **Change needed:** the room is registered by the laptop's first connection
  (`index.js:38`). A phone-only user needs a phone-created room: the phone generates the
  pairing, and a Mac pairs into it later by scanning the phone's QR. That is the reverse of
  today.

### 3b. Git branches are how cloud sessions write (option A)

A cloud session can't reach the relay by default. It runs `genlock` as normal and pushes
`.genlock/records` on its own branch. Reading that branch's records is the same idea as
`allRecordDirs()`, which already unions every worktree's records:

- **Phone:** reads `.genlock/records` from each open `claude/*` branch through the GitHub
  API and unions the events into its table, which then flow to the Mac through the relay.
  It also shows the session URL.
- **Mac:** `genlock` gains a read of `origin/*` branch records alongside its worktrees, after
  `git fetch`. That is a change to `store.mjs`, for later.
- The branch merging into main loses nothing: union merge, with duplicates dropped on
  replay.

### Ordering and conflicts

- **Within a record:** order comes from `at`. A device that has seen the record's last event
  stamps after it, so causal order holds. Two devices editing one ticket concurrently are
  ordered by wall clock. For the operations that matter (status, `met`, `done`) replay is
  already idempotent, and for `rank` and `due` the last write wins.
- **Clock skew:** a phone that is minutes slow could sort its edit before an older Mac edit.
  The `+1 ms after the last seen event` rule bounds this for anything it has seen. I don't
  propose more until it bites.
- **Nothing is ever deleted**, so there is no tombstone problem. Withdrawals are events, as
  they are now.

---

## 4. What TJ needs to choose

1. **Which way the phone starts sessions:**
   - A (cloud sessions through routines, Max plan, preview API)
   - B (Managed Agents, API bill, full control)
   - A for work plus C for talk *(recommended)*
   - something else
2. **Is an API key acceptable** for C, or B, as a separate small bill? If not, the phone has
   no Tally of its own and talking goes through cloud sessions only.

Once those are answered, the build tickets follow: the relay event log and phone-created
rooms; the phone's SQLite store and the Kotlin replay with the conformance suite; the
routine setup and `/fire` button; and the GitHub branch reader.

Sources checked 2026-11-13: code.claude.com/docs/en/claude-code-on-the-web, /routines,
/remote-control, /authentication, /agent-sdk/overview; API prices from the bundled
claude-api reference (cached 2026-11-03).
