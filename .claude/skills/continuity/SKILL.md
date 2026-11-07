---
name: continuity
description: Stop and pick work back up with nothing lost. Use when the user says "start a handoff", "wrap up" or that they will clear context, and when they say "continue the goal we were working on" or "pick this back up".
---

Use the `genlock` command, or the genlock MCP tools if connected. If it is not on PATH, use `npx @locklainn/genlock`.

## Continuity: stop and pick back up with nothing lost

There is no handoff document. Goals say what is next, tickets say what just happened, and everything live is read when asked for.

    genlock orient                          # at the start of a session
    genlock checkpoint [--uncommitted ".."] # before context is cleared
    genlock continue [GOAL|TICKET]          # to carry on
    genlock followups                       # what this session found and has not finished
    genlock swap GOAL --user-said ".."      # on the user's yes: a fresh session on GOAL

- **"Start a handoff" means run `genlock checkpoint`.** Also "wrap up", or "I'm going to clear context". It refuses and names what a fresh session would be missing. Fill each gap with what is actually true, then tell the user it is safe to clear.
- **"Let's continue the goal we were working on" means run `genlock continue`.** If it says more than one goal could be meant, ask which. Then take a ticket with `genlock start ID`.
- **When this session's work is done, offer to swap it for a fresh one.** A long conversation costs more every turn and blurs when it is compressed; a fresh session on the next goal is cheaper and sharper, as long as the records hold everything. At every natural finish (a ticket done, a goal's next thing done, the user moving on) run `genlock followups`, then offer in one short message: what was finished, what is still open from this session, the goal the fresh session would open on, and a yes/no. Do not offer mid-task, and do not offer twice for the same finish.
- **Swap only on the user's yes:** `genlock swap GOAL --user-said "THEIR WORDS"`. It refuses while a fresh session would be missing anything; fill each gap with what is true and run it again. In the Genlock app the session is replaced once your turn ends and this conversation stays under Recently ended, so end your reply in one line. Elsewhere it tells you what the user runs instead; pass that on.
- **Say what must not be done** with `genlock forbid ID "..." --lifted-by ".."`, and what a later agent must check with `genlock hazard TICKET "..." --verify ".."`. Both are printed until lifted or cleared. Restarting a blocked ticket needs `--because`. A stop or a block means stop: do not retry it under another name or hand it to another agent.
- **Findings do not go in records.** What the work established stays in files; `genlock ref ID PATH --why ".."` points at them. `latest` is limited to 600 characters, on purpose. Withdraw a decision with `genlock decide ID ".." --supersedes N`; it stays visible so nobody re-adds it.
- **Records are claims about the repository, not sources.** Check anything load-bearing before acting on it.
- **Do not write a separate handoff file.** Put it on the goal or the ticket. A second copy goes stale and still reads as current.
- **Commit `.genlock/` with the work when the user asks for a commit,** or with `genlock sync`. `.genlock/` must not be discarded by a git cleanup: uncommitted records exist nowhere else.
