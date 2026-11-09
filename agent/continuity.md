## Continuity: stop and pick back up with nothing lost

There is no handoff document. Goals say what is next, tickets say what just happened, and everything live is read when asked for.

    genlock orient                          # at the start of a session
    genlock checkpoint [--uncommitted ".."] # before context is cleared
    genlock continue [GOAL|TICKET]          # to carry on
    genlock followups                       # what this session found and has not finished
    genlock close --self --user-said ".."   # on the user's word: this session closes itself
    genlock swap GOAL --user-said ".."      # on the user's yes: the same work carried on in a fresh session

- **"Start a handoff" means run `genlock checkpoint`.** Also "wrap up", or "I'm going to clear context". It refuses and names what a fresh session would be missing. Fill each gap with what is actually true, then tell the user it is safe to clear.
- **"Let's continue the goal we were working on" means run `genlock continue`.** If it says more than one goal could be meant, ask which. Then take a ticket with `genlock start ID`.
- **When the work this session set out to do is done, say so and stop.** Run `genlock followups`, then tell the user in one line that everything planned is done ("All work is done for what we planned to do!"), plus anything this session left open. Do not suggest the next goal or offer to swap onto it: that makes finished work feel unfinished, and what comes next is the user's to bring up.
- **Close on the user's word:** when they say you can close, `genlock close --self --user-said "THEIR WORDS"`. It refuses while the records would lose anything; fill each gap with what is true and run it again. In the Genlock app the session closes once your turn ends and stays under Recently ended, so end your reply in one line. Elsewhere the user closes it with `/exit`; say so.
- **Swap only to carry on the same unfinished work,** when the conversation has grown long: a long conversation costs more every turn and blurs when compressed, and a fresh one starts sharp from the records. Offer it once, in one line; on the user's yes, `genlock swap GOAL --user-said "THEIR WORDS"` with the goal you are on. It refuses while a fresh session would be missing anything; fill each gap and run it again. In the Genlock app the session is replaced once your turn ends and this conversation stays under Recently ended, so end your reply in one line. Work split off from this one is a spin-off, not a swap.
- **Say what must not be done** with `genlock forbid ID "..." --lifted-by ".."`, and what a later agent must check with `genlock hazard TICKET "..." --verify ".."`. Both are printed until lifted or cleared. Restarting a blocked ticket needs `--because`. A stop or a block means stop: do not retry it under another name or hand it to another agent.
- **Findings do not go in records.** What the work established stays in files; `genlock ref ID PATH --why ".."` points at them. `latest` is limited to 600 characters, on purpose. Withdraw a decision with `genlock decide ID ".." --supersedes N`; it stays visible so nobody re-adds it.
- **Records are claims about the repository, not sources.** Check anything load-bearing before acting on it.
- **Do not write a separate handoff file.** Put it on the goal or the ticket. A second copy goes stale and still reads as current.
- **Commit `.genlock/` with the work when the user asks for a commit,** or with `genlock sync`. `.genlock/` must not be discarded by a git cleanup: uncommitted records exist nowhere else.
