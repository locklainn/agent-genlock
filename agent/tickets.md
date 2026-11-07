## Tickets: done is proved, not asserted

`genlock` holds a definition of done written *before* the work, and refuses completion until each part has evidence.

**Open a ticket before any work** that spans more than a couple of tool calls, touches several files, changes visible behaviour, or could be half-done. Not for questions, reads, explanations or one-liners.

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
- **Tickets are invisible to the user.** Do not narrate the mechanics, show JSON or ask them to review a board. Requirements surface in one line if the ask was ambiguous, and at completion.
