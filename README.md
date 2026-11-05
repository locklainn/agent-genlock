# genlock: keeps coding agents in sync

In video, a *genlock* locks several sources to one timing signal. Here the signal is a repository's goals and tickets: every agent reads them, keeps them current, and stays out of the others' way.

```console
$ genlock orient
Goals:
  G-6F84H  Search finds plural words — 1 of 3 tickets done
    next 1. Wire up stemming
    DO NOT: do not deploy until the index is rebuilt

Deadlines:
  G-NSD5T  2. Last day to refile  [due 2026-12-30, in 56 day(s)]

Waiting on the user. Raise these when it fits; do not decide them yourself:
  Q-57HRK (G-6F84H): Should plural matching apply to names?

Other sessions working here right now. Stay out of these:
  T-DMZ9Y: src/footer
```

Say **"start a handoff"** and the agent runs `genlock checkpoint`, which refuses until a fresh session would be missing nothing. Clear context. Say **"let's continue the goal"** and the agent runs `genlock continue`.

## Modules

Each works without the others, except where noted. Install only what you want.

| module | what it does | needs |
|---|---|---|
| `labels` | `[TASK-COMPLETE]`, `[STATUS-UPDATE]`, `[TECH-REPORT]`, `[GRILLED]`, `[ASSUMING]`. Rules only, no CLI | nothing |
| `tickets` | Requirements first; `done` refuses without evidence | nothing |
| `goals` | What the work is for and what is next. Agents propose; only the user sets or closes | nothing |
| `coordination` | Claims on files and shared resources; questions between sessions | nothing |
| `reviews` | Files the agent wants you to look at stay on a list until you have | nothing |
| `continuity` | `orient`, `checkpoint`, `continue` | tickets, goals |
| `spinoffs` | Move a tangent into its own session once it is shown to be safe and the user says yes | tickets, coordination |

## Install

You need [Node](https://nodejs.org) 16 or newer and git. The same commands work on macOS, Linux and Windows.

```bash
npm install -g github:locklainn/agent-genlock   # once per machine; run again to upgrade
cd your-repository
genlock init --private                          # or --shared; rules, hooks, MCP server, skills for this repository
genlock doctor                                  # confirms it took
```

Then restart your agent session. That is all. From then on, just talk to your agent: it picks up goals as the work makes them clear.

**`--private` or `--shared`?** Records are permanent logs that can quote people. `--private` keeps them out of git, on your machine only: use it for a public or sensitive repository. `--shared` commits them with your work, so they have history and reach other machines.

**Work already under way here?** `genlock guide` covers bringing across status notes and handoff documents without losing anything.

To remove it: `npm uninstall -g @locklainn/genlock`, then see the end of `genlock guide`.

| platform | new terminal for a spin-off |
|---|---|
| macOS | Terminal or iTerm |
| Windows | PowerShell |
| Linux | your default terminal, if one can be found |

Wherever a window cannot be opened, genlock prints the command to run instead. On Windows, `.mcp.json` is written for Windows, so if your team mixes platforms, register the server per person instead: `claude mcp add --scope user genlock -- genlock mcp`.

### Choosing pieces

```bash
genlock install --only goals,tickets   # just these modules' rules
genlock install --hooks                # Claude Code hooks: orient, guard, deliver
genlock install --mcp                  # register the MCP server in .mcp.json
genlock install --skill                # one skill per module
genlock install --global               # into ~/.claude, so it applies to every repository you open
genlock install --check                # say what would change, write nothing
```

Other agents (Cursor, Codex, Windsurf, Copilot, Gemini, Cline) get the rules in their own instruction file. Hooks and spin-off windows are Claude Code only.

## The Mac app

`app/` holds a native Mac app: a dashboard of every project sorted into TODAY, SOON and LATER, live Claude Code sessions in split panes, a panel of goals, tasks and files to review that updates as agents work, and voice. See [`app/DESIGN.md`](app/DESIGN.md).

```bash
npm install -g github:locklainn/agent-genlock   # the app displays what this records
cd app && ./scripts/install.sh                  # builds it and puts it in /Applications. Needs Xcode
```

## There are no handoff documents

A separate document goes stale and still reads as current. So state lives in one place, and every summary is a view of it.

| what a handoff held | where it lives |
|---|---|
| What to do next, in order, with dates | The goal's next things: `goal next G "..." --due DATE` |
| What just happened | The ticket's latest: `update T "..."`, 600 characters at most |
| Decisions, and withdrawn ones | `decide ID "..." --user-said ".." [--supersedes N]` |
| What must not be done | `forbid ID "..." --lifted-by ".."`, printed until lifted |
| What is waiting on you | `ask user "..." --about G`, listed at every session start |
| Files or processes left behind | `hazard T "..." --verify ".."`, printed until cleared |
| Dormant work | `goal park G --waiting-on ".."` |
| Findings, reference, what is established | **Files.** `ref ID PATH --why ".."` points at them |
| Uncommitted files, who holds what | Read live when asked for |

## Coordination

Durable records and live coordination are stored apart, because they have opposite needs.

**Records** (`.genlock/records/`, committed) are built so that two branches cannot conflict: one file per record, random ids, and append-only lines with git's union merge. State is computed by replaying events, so a line that arrives twice counts once. Every worktree sees every other's records before anything merges. The merge rule is written beside the records with the first one.

**Claims** (`.git/genlock/`, never committed) say who is working where. No checkout touches them, and all worktrees share them. A claim is a lease, so a dead agent cannot hold anything for long. Check-and-claim runs under a lock, because "check, then act" is the race several agents lose together.

**The guard** is a Claude Code hook. It blocks an edit to a file another session holds, an edit outside what a spin-off declared, and the git commands that wreck someone else's uncommitted work in a shared tree (`stash`, `checkout`, `switch`, `restore`, `clean`, `reset --hard`, `add -A`, `commit -a`). It is a seatbelt for cooperating agents, not a security boundary: a shell command that writes a file is not seen, and neither is a variant of those commands it does not match.

**Questions** are records too. A running session cannot be interrupted, so a hook delivers a question at its next tool call, and nobody waits for the answer. Status questions need none of this: any session reads the shared records.

## Spin-offs

```bash
genlock claim T-PARENT --path src/search
genlock spinoff propose "Footer links reach the archive" --parent T-PARENT --why ".." --context ".." \
  --path src/footer --needs none --blocks none
```

The check fails closed. It says NOT SAFE if the parent has declared nothing (so "no overlap" would prove nothing), if the paths or resources collide with a live claim, if uncommitted changes are already in its paths, if it needs the parent's unfinished work, or if the parent would wait for it. The ticket is recorded either way.

If safe, the agent offers it in one line. On your yes, `spinoff launch --user-said ".."` re-checks, takes the claim, and opens a new terminal window, all under one lock. Declarations are only as honest as the agent making them; the check can catch collisions, not a wrong answer to `--needs`.

## MCP

`genlock mcp` serves every operation as a named tool (`orient`, `goals_list`, `goal_next`, `ticket_update`, `checkpoint`, `continue_work`, `ask_session`, `ask_user`, `spinoff_propose`, ...). Each one runs the CLI, so a refusal is the same refusal. Hooks are still needed for anything that must happen whether or not an agent chooses to call a tool.

## What it refuses

| refused | the reason |
|---|---|
| `-r "make search better"`, or a requirement with no check | nothing here could come out false |
| `done` with an unproved requirement or unanswered grill | the original point |
| `goal add`, `accept`, `done` without `--user-said` | goals belong to the user |
| `checkpoint` with a stale latest, stale next things, or unexplained uncommitted files | a fresh session would be missing them |
| `update` over 600 characters | a long latest is a handoff document in disguise |
| `start` on a blocked ticket without `--because` | a block does not clear itself |
| `spinoff launch` without `--user-said` | it opens a window and spends usage in parallel |
| `claim` on something another session holds | pick other work; do not wait |

Exit codes: `0` fine, `1` usage or not found, `2` lint refused, `3` not done or not ready, `4` conflict or unsafe.

## Tests

```bash
node tests/run.mjs
```

Almost every assertion is a refusal. Merge tests run real `git merge` and `git rebase`, and the claim race runs real parallel processes, since those are claims a mock could not falsify.

## Files

| path | what it is |
|---|---|
| `bin/genlock.mjs` | the CLI |
| `lib/` | `store` records, `tickets`, `goals`, `claims`, `continuity`, `ask`, `spinoff`, `mcp`, `lint` |
| `agent/` | each module's rules, for an agent's instructions; `tickets.full.md` is the long form |
| `skills/` | one Claude Code skill per module |
| `docs/ADOPTING.md` | what `genlock guide` prints |
| `install.mjs` | writes rules, hooks, MCP config and skills, idempotently |

MIT.
