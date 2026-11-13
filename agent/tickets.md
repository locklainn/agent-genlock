## Tickets: done is proved, not asserted

`genlock` holds a definition of done written *before* the work, and refuses completion until each part has evidence.

**Open a ticket before any work** that spans more than a couple of tool calls, touches several files, changes visible behaviour, or could be half-done. Not for questions, reads, explanations or one-liners. **Almost all work belongs under a started task**, because the sprint report is built from completed tasks; a goal is optional for odd work, a task is not. Editing files with no started task gets you a reminder, and `genlock sweep` marks the session.

    genlock new "TITLE" --short "NAME" -r "REQUIREMENT" -c "CHECK" [-r .. -c ..] [--goal G]
    genlock start ID
    genlock update ID "what just happened, and where it stands"
    genlock met ID N --evidence "WHAT YOU OBSERVED"
    genlock assume ID "WHAT" --breaks "WHAT IF WRONG"
    genlock decide ID "WHAT WAS DECIDED" [--user-said ".."]
    genlock grill ID --observed .. --cause .. --absence .. --assumption .. --falsify ..
    genlock done ID      # exits non-zero and names the gap if anything is unproved

- **A requirement is TRUE or FALSE once the work is finished**, with a check written up front: a command, or `manual:` / `file:` / `eye:`. `make search better` is refused. Three to six per ticket, covering the whole ask.
- **`--evidence` is what you OBSERVED.** `ran the tests` is not evidence; `test/search.mjs budgets -> 12 hits` is.
- **Keep `latest` current as work moves.** It is what the next session reads, and the only account of this work if this session dies.
- **A waiver is not a proof.** It needs a reason, and the user's agreement if it drops something they asked for.
- **`genlock done` exiting zero is the only thing licensing the words "done", "complete", "finished", "working" or "ready".** Relay the lines it prints. Never edit `.genlock/` by hand.
- **A screenshot or file the user sends belongs on the ticket it is about:** `genlock attach ID FILE --why ".."`. It keeps a copy (an upload or a temp screenshot vanishes later), `genlock show` prints where. Purging the copies is the user's call: `genlock purge ID --user-said ".."`.
- **Tickets are invisible to the user.** Do not narrate the mechanics, show JSON or ask them to review a board. Requirements surface in one line if the ask was ambiguous, and at completion.

**Bugs: the cause goes on record, so retros can find the ones that are systemic.** Fixed one at a time, a cause shared by several bugs stays invisible. Open a ticket with `--bug` when the work is a defect: something built that does not behave as intended (a feature request is not a bug; `genlock bug ID` converts a ticket opened without it).

    genlock new "TITLE" --bug --found-by "playtest 2026-11-13" -r .. -c .. --goal G
    genlock cause ID --symptom .. --root-cause .. --why .. --why .. --scope one-off|systemic \
      --system .. --class .. --corrective .. --preventive .. --gate ..
    genlock retro GOAL   # clusters causes across the goal's bugs; drafts systemic tickets for the user

- **Find the root cause before fixing.** Ask why until the answer is something changeable; a fix to the symptom alone fails `done`, which refuses a bug ticket until symptom, root cause, scope, system, class, corrective and preventive are set.
- **Reuse names.** `genlock classes` is the cause vocabulary (`classes add` extends it); `cause` prints the systems and classes already on the goal, and the bugs that share yours. Converge on them.
- **Prefer the systemic fix.** If you choose a one-off fix for a shared cause, say why. A preventive is a check plus `--gate`, where it runs before a change lands; a guard nobody runs prevents nothing.
- **Offer a retro** when `done` or `goal show` says ten bugs have closed since the last one, or at the end of a playtest. Its proposed tickets are drafts: the user decides which become work.
