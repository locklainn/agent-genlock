# tkt — agent-driven tickets. Done is proved, not asserted.

**The problem.** Coding agents report work finished before it is finished. Not from
dishonesty — from having no definition of finished to check against. *"I have written
the extractor"* and *"the extractor works"* are indistinguishable from the inside, and
the second is what gets said.

**The fix.** A definition of done written **before** the work starts, and a command
that refuses to accept completion until each part of it has recorded evidence. The
refusal is mechanical, because a rule you check by reading lasts until the next
session.

```console
$ tkt done LBB-0007
tkt: LBB-0007 is NOT done.

  - requirement 2 is unproved: the rebuild exits zero on an empty corpus
      its check: node build.mjs; echo $?
      -> tkt met LBB-0007 2 --evidence "what you observed"
  - the grill is unanswered: absence, falsify
      -> tkt grill LBB-0007  (to see the questions)

  Nothing may be reported complete while any of the above is true.
$ echo $?
3
```

**And a consequence worth the price on its own:** you cannot write requirements for an
ask you do not understand. So this forces the understanding to the front, where it is
cheap, instead of surfacing as a wrong deliverable at the end.

## Install

Node 16+ and nothing else. No dependencies, no Python, no compiler, no database.
Works on macOS, Linux and Windows. Node is already a dependency of most coding agents.

```bash
npx @locklainn/tkt install          # wire it into this repo's agent file
npm i -g @locklainn/tkt             # or install the command globally first
```

`tkt install` detects `CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
`.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `GEMINI.md` or
`.clinerules` and writes the protocol into each, between managed markers so re-running
replaces the block rather than appending a second copy.

```bash
tkt install --global      # into ~/.claude/CLAUDE.md, so it applies to every repo
tkt install --full        # the whole protocol (1,700 words) instead of the compact one (400)
tkt install --skill       # also install the Claude Code skill
tkt install --check       # say what would change, write nothing
tkt install --target AGENTS.md --target docs/agent.md
```

**Single-file install**, if you would rather not add a dependency: copy `bin/tkt.mjs`
anywhere on PATH as `tkt` and paste `agent/PROTOCOL.compact.md` into your agent's
instructions by hand. The file has no imports outside Node's standard library.

## The loop

```bash
tkt new "TITLE" -r "REQUIREMENT" -c "CHECK" [-r .. -c ..]   # before starting
tkt met ID N --evidence "WHAT YOU OBSERVED"                 # as each one lands
tkt assume ID "WHAT" --breaks "WHAT IF WRONG"               # at a fork you cross
tkt grill ID --observed .. --cause .. --absence .. --assumption .. --falsify ..
tkt done ID                                                 # it may refuse
```

Ids may be bare numbers inside their own repo: `tkt done 7`.

## What it refuses, and why each refusal is there

| refused | the reason |
|---|---|
| `-r "make search better"` | "better" is a feeling. Nothing here could come out false |
| a requirement with no `-c` check | a requirement with no check is a wish |
| a ticket with no requirements | there is nothing that "done" could mean |
| `tkt met` with no `--evidence` | *that you did the thing* is not *what you observed* |
| `tkt done` with an unproved requirement | the entire point |
| `tkt done` with an unanswered grill | five fixed questions, below |
| `tkt waive` with no `--reason` | a waiver is an argument; it has to be made |
| `tkt assume` with no `--breaks` | an assumption with no consequence cannot be weighed |
| `tkt done` on a `--loose` ticket | bypassing the lint forfeits the guarantee |

A waiver is reported separately from a proof, everywhere, and never summed into one
figure. `2 of 3 proved, 1 waived` — never `3 of 3`.

## The grill: five fixed questions

Answered before `done`, and the list does not adapt to the task. A grill you generate
per ticket is unfalsifiable — nothing stops an agent inventing five easy questions and
passing.

| field | question |
|---|---|
| `--observed` | Observed, or derived? Cite the coordinate and the raw value |
| `--cause` | Is any cause stated here a measurement, or a hypothesis? |
| `--absence` | Anything reported missing that the instrument only failed to match? |
| `--assumption` | Which assumption here is mine, that nobody chose? |
| `--falsify` | What one check, document or number would falsify this? |

Each is a mistake that actually happens. The third is the one agents make most: a grep
that found nothing, a query with no rows, a pattern that refused — every one is a
statement about the tooling, not about the world.

## The labels it prints

Status reporting comes **from** the ticket, so the tool writes the line and the agent
relays it rather than composing its own.

| label | answers | printed by |
|---|---|---|
| `[TASK-COMPLETE]` | *is it done?* | `tkt done` — measured, never felt |
| `[STATUS-UPDATE]` | *what moved?* | `tkt status` — always a number and a direction |
| `[GRILLED]` | *what survived?* | `tkt done` |
| `[ASSUMING]` | *what was taken for granted?* | `tkt assume` |
| `[TECH-REPORT]` | *why?* | typed by hand; it changes nothing about what is done |

`[STATUS-UPDATE]` and `[TECH-REPORT]` are the pair that gets confused. *"The town
changed the table format after FY2023"* is not a status update — it explains why a
count did not move. **The count moving is the status.**

## Invisible by design

The objective is that a human never opens a ticket while agents always work from one.

- **Nothing is written into your repository.** Tickets live in `~/.tkt/<repo>/`, keyed
  by git repository name. No directory appears in a diff, no ticket is ever committed,
  and two agents in two worktrees share one board.
- **The agent does not narrate the mechanics** — no "opening a ticket", no JSON, no
  command transcripts.
- **Requirements surface at exactly two moments**: a one-line confirmation if the ask
  was ambiguous enough that getting it wrong would waste real work, and at completion,
  where `tkt done` prints them beside the evidence.

That last point answers the obvious hole. An agent that writes its own requirements
invisibly can write easy ones and pass — so they are shown at the moment completion is
claimed. That costs the reader three lines and makes the easy ones visible.

## Where state lives

```
~/.tkt/
  config.json              id prefixes, one per scope, stable once assigned
  <repo-name>/
    ABC-0001.json          one ticket, one file
```

Override with `TKT_HOME`. Force a scope with `TKT_SCOPE` (useful in CI, worktrees, or a
monorepo where each package should keep its own board). `tkt where` prints both.

There is no index and no database: a ticket is one small JSON file and the board is a
directory listing. Nothing to migrate, nothing to corrupt, and `grep` works.

## Commands

```
tkt new "TITLE" -r "REQ" -c "CHECK" [--ask ".."] [--quiet] [--loose]
tkt list [--open] [--all] [--status S]      tkt show ID [--json]      tkt status ID
tkt start ID                                 tkt req ID -r ".." -c ".."
tkt met ID N --evidence ".."                 tkt fail ID N --evidence ".."
tkt waive ID N --reason ".."                 tkt assume ID ".." --breaks ".."
tkt grill ID [--observed .. --cause .. --absence .. --assumption .. --falsify ..]
tkt done ID                                  tkt block ID "WHY"   tkt abandon ID "WHY"
tkt note ID "WHAT"                           tkt lint -r ".." -c ".." | tkt lint ID
tkt scopes | tkt where | tkt install | tkt help | tkt --version
```

Exit codes: `0` fine, `1` usage or not found, `2` the lint refused, `3` **not done**.
Script against `3` in CI to fail a build that claims completion it cannot prove.

## Tests

```bash
node tests/run.mjs        # 42 assertions, no dependencies
```

Almost every one asserts a **refusal**. The tool's whole value is that it says no, so a
suite exercising only the happy path would have no power to fail.

## Files

| path | what it is |
|---|---|
| `bin/tkt.mjs` | the entire tool. One file, no dependencies |
| `agent/PROTOCOL.md` | the full protocol and the reasoning, for an agent's instructions |
| `agent/PROTOCOL.compact.md` | the same rules in 400 words, for a tight context budget |
| `skills/ticketed-work/SKILL.md` | the Claude Code skill |
| `install.mjs` | detects and writes into agent instruction files, idempotently |
| `tests/run.mjs` | the suite |

MIT.
