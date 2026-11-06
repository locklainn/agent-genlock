# Genlock for Mac: design and requirements

**Status:** first version built, 5 November 2026. See Verification for what has and has not been proven.

## What it is

One window onto all your projects and the agents working in them. A dashboard shows every project, sorted by how much it matters right now. Click one and you are in a Claude Code session, with its goals, tasks and files for review beside it, updating live as the agent works.

## The problem

Working with several agents across several repositories means holding the state of each in your head. What was the goal? What happened last? Which file did it want me to read, three screens up? Which project matters today? genlock already records all of this. Today the only way to see it is to ask an agent.

## Who it is for

One person running several Claude Code sessions across several repositories on a Mac. Sharing with other people is out of scope for this version.

## Principles

1. **The genlock CLI is the only source of truth.** The app displays records; it never parses or writes them directly. Two readers of one format is how they come to disagree.
2. **The session is real Claude Code.** A real terminal running the real `claude`, so nothing behaves differently from Terminal and nothing needs re-implementing when Claude Code changes.
3. **The app does not touch your repositories on its own.** Looking at a project writes nothing to it. Only an action you take can write: setting a project up, or marking a review done.
4. **Your priorities are yours, not the project's.** Tiers live on your Mac and are never committed.

---

## Vocabulary

| term | meaning |
|---|---|
| **Project** | A folder, as in Claude Code. It usually contains `.genlock/`, but does not have to |
| **Tier** | TODAY, SOON or LATER: how much a project matters right now |
| **Card** | A project on the dashboard |
| **Session** | A Claude Code process running in a project, inside the app |
| **Pane** | One session on screen. A split shows several panes |
| **Inspector** | The panel beside a session showing its goals, tasks and reviews. The standard Mac term for what you called a slide-out |
| **Current goal** | The active goal with the most recent activity, including its tickets |
| **Last task** | The ticket most recently updated, whatever its status |

---

## Look and feel

Dark, vivid and alive: an enterprise product that is exciting to open, rather than a utility. Decided 5 November 2026, after the first version read as a plain form.

- **One motif.** The genlock signal: three square waves locked to one clock. It is the mark, and the voice meter's shape.
- **One shape, one meaning.** A waveform is only ever voice. Work in progress is pixels forming into a block, always with a word beside it: Working, Setting up, Loading.
- **Depth.** A near-black canvas with slow colour moving behind it, and glass surfaces on top.
- **Tiers have identity.** TODAY is hot coral to amber, SOON cyan to blue, LATER violet. That colour follows a project into its pane.
- **Numbers lead.** The dashboard opens with live sessions, waiting on you, to review and due this week.
- **One thing to press.** Visual hierarchy: if everything shouts, nothing does. The dashboard has no filled buttons, because its main action is the card itself. The selected tab is an underline, Add project is quiet, and secondary steps are text links. A filled button appears only when it is the one real choice in view, such as first run or a pop-up. Decided 5 November 2026.
- **Things move because something happened.** Cards lift on hover, a running session pulses, progress rings animate, and a change by an agent glows briefly. All of it respects Reduce Motion.
- **No stock controls** on app screens. Buttons, pills, rings and the setup screen are custom; only menus and the system file picker stay native.

`Theme.swift` holds every colour, surface and control.

## Screens

### Dashboard

```
┌ Genlock ─────────────────────────────────────────────── [+ Add project] ┐
│  TODAY                   SOON                     LATER                 │
│ ┌──────────────────┐   ┌──────────────────┐     ┌──────────────────┐    │
│ │● budget-dashboard│   │  agent-genlock   │     │  recipe-tracker  │    │
│ │ Publish journal  │   │ Ship the Mac app │     │ No goal yet      │    │
│ │ next: build pages│   │ next: inspector  │     │                  │    │
│ │ ✓ Ticket title   │   │ > Ticket title   │     │                  │    │
│ │   2h ago         │   │   5m ago         │     │                  │    │
│ │ 5 ask  2 review  │   │ due in 3 days    │     │                  │    │
│ └──────────────────┘   └──────────────────┘     └──────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

Shown here as the All view: three columns, one per tier. By default the dashboard shows only one tier, chosen by tabs (⌘1 to ⌘4), so you can focus on TODAY. `●` means a session is running. Each card leads with the current goal, because that is what you are scanning for.

### Session

```
┌ ← Dashboard   [budgetapp ●] [genlock ●]                                 ┐
│ ┌ budget-dashboard ──────────────────[×]┐ ┌ Inspector ────────────────┐ │
│ │                                       │ │ GOAL                      │ │
│ │  Claude Code, in a real terminal      │ │ Publish the journal  1/3  │ │
│ │                                       │ │ NEXT                      │ │
│ │                                       │ │ 1. Build the pages        │ │
│ │                                       │ │ TASKS                     │ │
│ │                                       │ │ > Tie the totals  2 of 4  │ │
│ │                                       │ │   latest: 12 of 40 tie    │ │
│ │                                       │ │ WAITING ON YOU  (5)       │ │
│ │                                       │ │ TO REVIEW  (2)            │ │
│ │                                       │ │ ☐ docs/plan.md            │ │
│ │                                       │ │   Is section 2 right?     │ │
│ └───────────────────────────────────────┘ └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Split

The same panes side by side, each with its own inspector. Two sit side by side, three in a row, four in a 2×2, five or six in 3×2. Dividers can be dragged. A pane narrower than 860 points gets a slimmer inspector, and one narrower than 560 slides it over the terminal when opened instead of pushing it.

---

## Requirements

Each one is either true or false once built, and says how it is checked. Checks marked **auto** are in the test suite; **drive** means run through the built app with synthesised input events; **eye** needs a person.

### Projects

| id | requirement | check |
|---|---|---|
| P1 | A project is any folder. One with no `.genlock/` still appears and can open a session | auto |
| P2 | Projects are added with a folder picker or by dragging a folder onto the window | drive |
| P3 | With no projects yet, the app offers folders under your home that contain `.genlock/`, without touching Desktop, Documents, Downloads or Library | auto |
| P4 | The project list and tiers are stored in `~/Library/Application Support/Genlock/` and survive a restart | auto |
| P5 | Removing a project removes it from the app and changes nothing on disk in the project | auto |
| P6 | A project whose folder has gone shows as missing instead of disappearing or crashing | auto |
| P7 | A card for a project with no `.genlock/` offers Set Up, which asks private or shared, runs `genlock init`, shows it working, and on finishing the card changes and a message says what happened and what to do next | auto, drive |

### Dashboard

| id | requirement | check |
|---|---|---|
| D1 | The dashboard shows one tier at a time, opening on TODAY or wherever you left it, with tabs to switch and an All view showing the three as columns. Every project is in exactly one tier | auto, drive |
| D2 | A card shows the project name, current goal, the goal's first next thing, the last task with its status and age, and counts of what waits on you | drive |
| D3 | A card updates within 2 seconds of a change made by an agent, with no action from you | auto |
| D4 | A project moves between tiers by dragging it onto a tab or column, by context menu, by pressing 1, 2 or 3 on a hovered card, and from an empty tier's list of projects to pull in | drive |
| D5 | Dragging reorders cards within a tier, and the order survives a restart | auto, drive |
| D6 | A new project goes into the tier you are looking at, or SOON in the All view, and the app says where it went. Adding one already here shows it instead | auto, drive |
| D7 | A deadline within 7 days or overdue shows on the card | auto |
| D8 | A card shows when a session is running in that project | drive |
| D12 | A card shows what its latest conversation is about, Claude Code's title and last prompt, with no goals or setup needed. With a goal, the goal stays the heading | auto, drive, eye |
| D10 | The card is the dashboard's main action: clicking it opens the session, and hovering shows Open. Nothing has to be done first, so a card with no goal has no button at all. Setting up genlock is a quiet text link | auto, drive |
| D11 | In a focused tier, every card in a row is the same height and width, a sparse card matches a full one, and its button sits at the bottom | auto, drive |
| D9 | Each project can have its own icon, chosen from emoji, symbols or an image, shown on its card, session tab and pane. Until then it shows its first letter. Icons live with your projects on this Mac, never in the repository | auto, drive |

### Sessions

| id | requirement | check |
|---|---|---|
| S1 | Clicking a card opens that project's session, running real `claude` in its folder and carrying on its last conversation, visible and ready to type into immediately. A folder with no conversation starts a new one | auto, drive, eye |
| S2 | Shift-clicking several cards marks them, and releasing Shift opens all of them in a split | auto, drive |
| S3 | Returning to the dashboard leaves sessions running, and opening one shows it exactly as you left it | drive |
| S4 | A project has at most one main session, plus any spin-offs | auto |
| S5 | `claude` and `genlock` are found when the app is launched from Finder, where PATH is normally minimal | auto |
| S6 | When a session's process ends, the pane says so and offers a restart, and the app does not crash | drive |
| S7 | Sessions never stop because the app did. Quitting, restarting, updating or a crash leaves every session running, and reopening shows each as it is, with its history. Only ending a session stops it. Quitting therefore asks nothing | auto, drive |
| S8 | A split holds up to 6 panes. A seventh is refused with a message | auto |
| S9 | Keyboard input, paste, selection, colours and resize work in the terminal as in Terminal | eye |
| S10 | A context menu and the session-ended screen can start a new conversation instead | drive |
| S11 | Launching reopens every session that was open, spin-offs included, each in its own conversation, with the split as you left it. A session you ended or that exited stays closed. A folder that has gone is skipped | auto, drive |
| S13 | Each tab has a visible close button that ends its session, and its context menu can also start a new conversation. A running project is never lost by this: opening it again picks the conversation back up | drive, eye |
| S14 | A + at the end of the tabs opens a session for another project, or adds a folder, without going back to the dashboard | drive, eye |
| S15 | A folder whose history cannot be picked up, such as only `claude -p` runs, opens a new conversation and says so, rather than a dead pane | auto, drive |
| S16 | Dropping a file or folder on a pane types its escaped path at that session's prompt, and focuses it. Dropped anywhere else, a folder still becomes a project. A pane with nothing running refuses the drop | auto, drive, eye |
| S17 | ⌘V with a copied file types its path. With a copied image, it saves a PNG to a temporary folder and types that path. Copied text pastes as usual | auto, drive, eye |
| S20 | Goals and tasks each have one strict order, numbered from 1 with no ties, shared with agents through `genlock rank`. Dragging a row's handle onto another row takes that place | auto, drive, eye |
| S21 | A goal or task can have a due date, set and removed in place, and counted among a card's deadlines | auto, drive, eye |
| S23 | The panel shows what is going on now: tasks started, stuck or touched in the last day, plus up to 3 just finished, with started ones first. The rest of the tasks and other goals sit in a collapsed Backlog. Waiting on you shows 2 questions, clipped, until you ask for all of them | auto, drive, eye |
| S18 | The pane's status (Working, Needs you, Done) sits beside its name, away from the mic | eye |
| S19 | A changed source tree rebuilds itself in the background and offers "Restart to update". A failed build says why and retries on the next change | auto, drive |
| S12 | The conversation is the session's own, by id, so a spin-off or a Terminal session in the same folder cannot take its place, and `/clear` is followed | auto, drive |

### Inspector

| id | requirement | check |
|---|---|---|
| I1 | Every pane has an inspector, showing that project only. It opens by default and can be toggled per pane | drive |
| I2 | It shows the current goal with progress, next things and due dates, and other active and parked goals | drive |
| I3 | It shows open tasks with status, latest, and requirements on expanding | drive |
| I4 | It shows what waits on you, hard stops, and hazards | drive |
| I5 | It updates within 2 seconds of a change by the agent, and briefly highlights what changed | auto, eye |
| I6 | Other sessions' claims in this project are shown | drive |

### Files to review

| id | requirement | check |
|---|---|---|
| R1 | `genlock review PATH --why ..` records a request, refusing a missing file or an empty reason | auto |
| R2 | Open requests show in the inspector and as a count on the card | drive |
| R3 | Clicking one opens the file in its default app, or a URL in the browser | drive |
| R4 | A file that has since gone shows as missing instead of failing silently | auto |
| R5 | Marking one reviewed removes it from the open list, running `genlock review done` | drive |
| R6 | Agents are told to register every file they ask you to look at | auto: the rule is installed |

### Voice

Press to start, press again to send, with a key and with a button on screen. The agent answers aloud with only what matters, and asks whether to go deeper. The full written reply is still in the terminal.

| id | requirement | check |
|---|---|---|
| V1 | Pressing the mic button or tapping the right Option key starts listening to the focused pane; pressing either again sends what was said, as a message, with no further step | auto, eye |
| V2 | While listening, the words appear live on screen. Right ⌘, right beside right Option, cancels without sending anything, as do Esc and a button on screen. Right ⌘ is an ordinary key otherwise, apart from V15 | auto, drive, eye |
| V3 | Saying nothing sends nothing | auto |
| V4 | After a dictated message, the agent speaks a short version of its reply. It is told: only the important details, one to three spoken sentences, no paths, code or lists, and ask if it should go into more depth | drive |
| V5 | If the agent tries to finish a dictated turn without speaking, it is sent back once and only once, so a session can never be trapped | auto, drive |
| V6 | A turn you typed is not spoken | auto |
| V7 | Speech can be turned off with one button, in which case dictation still works and nothing is spoken. Pressing the mic or a stop button silences speech immediately | drive |
| V8 | With several sessions, replies queue rather than overlap, and each names its project | auto |
| V9 | Voice works in any folder without setting anything up or writing anything to the project | auto, drive |
| V11 | Replies are read by Ava, in the best quality installed, picked up automatically if you download a better one. If she is missing, the app falls back to American English and says how to get her | auto, eye |
| V12 | Any failure says what is wrong straight away, with a way to fix it: dictation turned off, permission denied, or nothing heard. It never just goes quiet | auto, drive |
| V13 | Pausing loses nothing. Words said before a pause stay on screen and are sent, however long the pause and whether or not you speak again | auto |
| A1 | The Assistant is one session across every project, opened from the dashboard or the session bar, or by talking on the dashboard. It reads live status with `genlock overview`, keeps each project's goals and tasks current with `genlock at`, and passes things on with `genlock tell` when you ask. Only it can use those commands | auto, drive |
| S22 | Every goal and task has a short name to say, from its title or chosen. Agents are told to use it with you and never read out ids, and genlock takes a short name or words from a title anywhere an ID goes | auto |
| A3 | The first time the Assistant is opened, the app asks what to call it: type a name, let it choose its own, or not now. The name shows everywhere, and it can be changed by asking it | auto, drive, eye |
| A2 | The Assistant keeps its context and manages it itself, invisibly. At a natural break it saves decisions to the project, saves the rest with `genlock remember`, and asks to clear with a handoff to itself. The app then starts it fresh with that handoff and a saved copy of the conversation, never mid-turn, mid-dictation or with a reply unheard. Nothing clears it on a timer | auto, drive |
| V15 | An agent never just starts talking. Its reply waits with a ding, a notice at the bottom, and a Dock and menu bar count. A clean tap of right ⌘ plays everything waiting and another stops it, with no mouse needed. With nothing waiting, it replays what you last heard, even after a restart. Replies outlast a restart, and right ⌘ in a shortcut does nothing | auto, drive, eye |
| V16 | Replies can be read at 1× to 3×, chosen from the speaker button, with a way to hear it. Holding the right arrow while it talks speeds it up until released, carrying on from the same word, and the arrow reaches the terminal as usual otherwise | auto, drive, eye |
| V17 | An update you have heard stays on screen for 5 minutes, saying who it is from. Right ⌥ or a reply box answers that session from wherever you are, without opening it, and its answer comes back the same way. Dictation says who it is going to when that is not the pane in front of you | auto, drive, eye |
| V14 | A long dictation shows its newest words. A spoken reply shows its words in the same place, at the bottom, with a way to stop it | auto, drive, eye |
| V10 | Recognition runs on this Mac when the Mac supports it. Denied microphone or speech permission gets a message saying where to allow it | read the code, eye |

### Spin-offs

When a rabbit hole comes up, the agent offers to move it to its own session, so this conversation's context stays small. On your yes, it opens beside the parent.

| id | requirement | check |
|---|---|---|
| O1 | Every session the app starts in a set-up project is told to watch for rabbit holes, and how to move one, with nothing to install | auto |
| O2 | The agent offers only after `genlock spinoff propose` says SAFE, in one line, and launches only on your yes, with your words on record | auto |
| O3 | On launch, a new pane running real `claude` joins the split beside its parent, under the session that holds the claim | drive |
| O4 | The new session starts from a handoff prompt naming its ticket and what it holds. It reads the ticket, goal and context, and writes requirements before starting | drive |
| O6 | A spin-off request from a different repository is refused with a message, because its ticket could not be found from the parent's folder | auto |
| O5 | A full split keeps the session running, reachable from the bar, and says so | read the code |
| O6 | Outside the app, `genlock spinoff launch` still opens a terminal window | auto |

### Knowing when you are needed

| id | requirement | check |
|---|---|---|
| N1 | Each session reports through Claude Code's own hooks whether it is working, done, or waiting on you, with nothing to set up in the project | auto, drive |
| N2 | When a session finishes or needs you, and you are not looking at it, macOS shows a notification naming the project | drive, eye |
| N3 | A notification for a session you can already see does not appear | auto |
| N4 | Clicking the notification brings Genlock forward on that session | eye |
| N5 | The menu bar icon shows a red dot and a count while any session needs you, and its menu goes straight to them. The Dock icon shows the same count | drive, eye |
| N6 | A session stops counting once you have seen it or it has resumed, and its notification clears | auto, drive |
| N7 | Cards and panes show the same state: needs you, done, or working | drive |

### General

| id | requirement | check |
|---|---|---|
| G1 | Viewing a project writes nothing to it: `git status` is unchanged and no `.git/genlock/` appears | auto |
| G2 | If `genlock` is missing or too old, the app says so and gives the exact command to fix it | auto |
| G3 | A project's `snapshot` failing shows an error on that card only, and other cards keep working | auto |
| G4 | Watching a large repository stays light: refreshes are debounced and only record changes trigger them | auto |
| G5 | The app is dark by design, whatever the system setting, with text that stays readable on it | eye |
| G6 | No network calls by the app itself and no telemetry | read the code |

---

## Architecture

```
                       ┌──────────────── Genlock.app ────────────────┐
 .genlock/records/ ──▶ │ ProjectWatcher ─▶ SnapshotClient ─▶ model ─▶ │ Dashboard
 .git/genlock/claims ─▶│   (FSEvents)      (genlock snapshot)         │ Inspector
                       │                                              │
 claude (PTY) ◀──────▶ │ TerminalSession (SwiftTerm)                  │ Panes
                       │                                              │
 App Support/  ◀─────▶ │ ProjectStore (project list, tiers, order)    │
                       └──────────────────────────────────────────────┘
```

**Stack.** Native SwiftUI, macOS 14 or newer, with [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) for the terminal. Chosen over Electron and xterm.js for lower memory across many open sessions and normal Mac behaviour. The cost is that it runs only on Mac.

**Live updates.** One FSEvents watcher per project, recursive on the project folder, filtered to paths under `.genlock/records/` and `.git/genlock/claims/`. A match schedules a debounced `genlock snapshot` per project. A 30-second timer catches what no file event signals, such as claims expiring and day counts.

**CLI contract.** `genlock snapshot` prints one JSON document with a `format` number. The app refuses a format it does not know, and says how to upgrade (G2).

**Finding tools.** An app started from Finder does not get your shell's PATH, and `claude` and `genlock` usually live under nvm. So the app asks a login shell for its environment once at launch, and uses that for both the CLI and sessions.

**Keeping sessions alive.** Each `TerminalSession` owns its terminal view and process, independently of the screen. SwiftUI re-parents the same view when the layout changes, so moving between dashboard and split neither restarts nor redraws a session.

**Voice.** Everything voice needs is passed when the app launches a session, so no repository has to change. `--append-system-prompt` carries the rule for dictated messages, `--settings` adds a Stop hook, `--allowedTools` lets the agent speak without a permission prompt, and `GENLOCK_APP_CHANNEL` names a private folder under Application Support.

```
press ──▶ on-device speech recognition ──▶ live words on screen
press ──▶ writes `pending`, types "[voice] words" + Return into the terminal
agent replies in writing, then runs `genlock say "short version"` ──▶ file in the voice folder
app notices the file ──▶ speaks it (AVSpeechSynthesizer), queued per app
agent stops without speaking and `pending` is still there ──▶ Stop hook sends it back, once
```

The right Option key is the shortcut because it does nothing alone in a terminal and is easy to find without looking.

**Spin-offs.** `genlock spinoff launch` runs its safety check and takes the claim as always. It then sees `GENLOCK_APP_CHANNEL` and drops a request in that folder instead of opening a window. The app notices, and starts `claude` with the handoff prompt under the session id that holds the claim, so the guard treats it as the holder. Its pane shares the project's inspector.

**Picking up where you left off.** `sessions.json`, beside the project list, holds which sessions are open, the split, and each session's conversation id. A new session is given its id with `--session-id` and later reopened with `--resume`. Hooks report the current id, which `/clear` changes. With no id remembered, or none with a transcript, it falls back to `--continue`. Whether reopening many sessions at once draws on usage limits has not been measured.

**What a card says it is working on.** The `ai-title` and `last-prompt` lines at the end of the conversation's transcript in `~/.claude/projects`. That format is Claude Code's own and undocumented, so anything unrecognised just leaves the card as it was.

**Knowing when you are needed.** Sessions the app starts carry `Stop`, `Notification`, `UserPromptSubmit` and `PostToolUse` hooks, passed at launch. Each runs `genlock session-state`, which writes `state.json` to the session's private channel. The app reads it on its timer and turns it into a notification, the menu bar badge and the state on cards and panes. A dictated turn sent back for not speaking is not reported as done.

**Layout.** `GenlockCore` holds everything that can be tested without a screen: snapshot decoding, the store, selection logic, split layout, and change detection. `Genlock` holds only views and the terminal.

### Changes to genlock itself

- `genlock snapshot`: read-only JSON of everything above. Built.
- `genlock review`: the new concept of a file awaiting review, as a CLI command, MCP tools, a rule and a skill. Built.
- Repositories already set up need `genlock init` re-run to receive the review rule.

---

## Decisions to check

Each is what I chose, and what would change if you disagree.

| # | decision | alternative |
|---|---|---|
| 1 | **Releasing Shift opens the split.** Nothing extra to click, but letting go between clicks opens early | An "Open 3" button, which is one more step but cannot fire early |
| 2 | **One main session per project, plus spin-offs.** A click always returns to the same place | Several freely-opened sessions per project |
| 3 | **A click carries on the last conversation.** Starting over loses work and starting new is one menu item away. This reversed the first version, which started new on every click and lost everything on every restart | A new session each time, relying on genlock's orient for context |
| 4 | **New projects go to the tier on screen.** Always visible the moment you add one | Always SOON, which hides them while you focus on TODAY |
| 5 | **Tiers are per-Mac, not in the repo** | Committed, so they would follow you across machines |
| 6 | **Three fixed tiers** | Renameable or more |
| 8 | **Right Option taps to talk.** Hold-free, as you asked, and on-screen button too | Another key, or a configurable one |
| 9 | **The spoken version comes at the end of a turn.** One summary per reply, with no narration while it works | Spoken progress during long work |

---

## Known limits

- **The review list depends on agents following the rule.** Nothing can reliably detect "please look at this file" in free text. R6 tells them to register; an agent that forgets leaves the panel empty, and the fix is asking it to. If this proves unreliable, a hook could scan replies for it.
- **The app reads what genlock records.** A project whose agent does not keep tickets and goals current shows a stale card. The app makes that visible; it cannot fix it.
- **Unsigned.** Built on your Mac it runs fine. Giving it to someone else needs an Apple Developer ID and notarization.
- **Dictation needs macOS Dictation turned on** in System Settings, Keyboard. Without it, recognition refuses, and the app says so.
- **Dictation accuracy** is Apple's speech recognition, which can stumble on code and names. The agent is told to read a dictated message charitably, and the words stay visible in the terminal.
- **The spoken reply depends on the agent's judgement of what matters.** The rule and the Stop hook make it speak; nothing can check that it chose well.
- **Claude's usage.** Each open session draws on the same limits, and a split of six is six at once. The app does not meter this.

## Out of scope for this version

Editing goals or tasks in the app (ask the agent); viewing files inside the app; answering waiting questions from the panel; other agents such as Cursor or Codex; multiple windows; Windows or Linux.

## Later

- Answering questions and accepting proposed goals from the inspector.
- Notifications when a deadline nears or an agent asks for review.

## Verification

**Run in the built app, with real Claude Code, 5 November 2026:** real events for Shift-click marking and opening a split; sessions surviving a return to the dashboard; an agent's change reaching the inspector; a dictated message answered aloud ("Four, mate."); and a rabbit hole moved to a spin-off, opening beside its parent and holding its own paths.

**A lesson in that list's limits:** a real click on a card opened a terminal positioned off screen, and no test noticed, because the app's own screenshots cannot draw the terminal and an earlier split happened to reposition it. Terminal placement now has its own measured check, but only a person's eyes have confirmed a real one on a real screen.

**Not yet exercised by anything:** speaking into the microphone, and the right Option key, because the first use asks your permission; dragging cards; clicking a review to open its file; typing and pasting in the terminal by hand; the session-ended and quit screens; and Ava in premium quality, which is an Apple download.

## How to build it

    cd app
    swift test                # everything that needs no screen
    ./scripts/build.sh        # produces build/Genlock.app
    ./scripts/install.sh      # copies it to /Applications

You only need this once. An app built this way notices when its source changes, waits for 20 quiet seconds, rebuilds in the background and offers "Restart to update", which leaves every session running. It also signs with an Apple Development identity if the Mac has one, because macOS forgets granted permissions when an ad hoc signature changes.

**Why sessions survive.** The app does not own them. Each `claude` belongs to its own `genlock-host` process (`Sources/GenlockHost`), which holds the terminal, keeps the last 4 MB of output, and has no parent to die with. The pane runs `genlock-host run`, which attaches and replays that output. A running host outlives the file it came from, so new apps talk to old hosts: frames may be added, never changed. After a reboot no host is left, and the same command starts one that resumes the conversation.
