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
    genlock close --self --user-said ".."   # on the user's word: this session closes itself
    genlock swap GOAL                       # conversation grown long: the same work carried on in a fresh session
    genlock open --handoff                  # the same with no goal to name: a fresh session takes this one's tasks
    genlock open --prompt ".."              # agreed work run beside this session, in this project (capped)

- **"Start a handoff" means run `genlock checkpoint`.** Also "wrap up", or "I'm going to clear context". It refuses and names what a fresh session would be missing. Fill each gap with what is actually true, then tell the user it is safe to clear.
- **"Let's continue the goal we were working on" means run `genlock continue`.** If it says more than one goal could be meant, ask which. Then take a ticket with `genlock start ID`.
- **When the work this session set out to do is done, say so and stop.** Run `genlock followups`, then tell the user in one line that everything planned is done ("All work is done for what we planned to do!"), plus anything this session left open. Do not suggest the next goal or offer to swap onto it: that makes finished work feel unfinished, and what comes next is the user's to bring up.
- **Close on the user's word:** when they say you can close, `genlock close --self --user-said "THEIR WORDS"`. It refuses while the records would lose anything; fill each gap with what is true and run it again. In the Genlock app the session closes once your turn ends and stays under Recently ended, so end your reply in one line. Elsewhere the user closes it with `/exit`; say so.
- **Hand long work to a fresh session yourself, to save tokens.** When the conversation has grown long and the work is unfinished, `genlock swap GOAL` with the goal you are on, or `genlock open --handoff` with none to name: a long conversation costs more every turn and blurs when compressed, and a fresh one starts sharp from the records. No yes is needed and you do not stop to ask; the fresh session begins at once. It refuses while a fresh session would be missing anything; fill each gap and run it once more, and if it refuses again, stop and leave the tasks open with their latest current. In the Genlock app this session closes once your turn ends and stays under Recently ended, so end your reply in one line. To run agreed work in parallel, `genlock open --prompt ".."` opens a session beside you in this project; sessions per project are capped so they do not pile up. A tangent is a spin-off.
- **Say what must not be done** with `genlock forbid ID "..." --lifted-by ".."`, and what a later agent must check with `genlock hazard TICKET "..." --verify ".."`. Both are printed until lifted or cleared. Restarting a blocked ticket needs `--because`. A stop or a block means stop: do not retry it under another name or hand it to another agent.
- **Findings do not go in records.** What the work established stays in files; `genlock ref ID PATH --why ".."` points at them. `latest` is limited to 600 characters, on purpose. Withdraw a decision with `genlock decide ID ".." --supersedes N`; it stays visible so nobody re-adds it.
- **Records are claims about the repository, not sources.** Check anything load-bearing before acting on it.
- **Do not write a separate handoff file.** Put it on the goal or the ticket. A second copy goes stale and still reads as current.
- **Commit `.genlock/` with the work when the user asks for a commit,** or with `genlock sync`. `.genlock/` must not be discarded by a git cleanup: uncommitted records exist nowhere else.
