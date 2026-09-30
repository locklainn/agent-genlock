## Ticketed work — done is proved, not asserted

`tkt` holds a definition of done written *before* the work, and refuses completion
until each part has evidence. Tickets live in `~/.tkt/<repo>/`, never in the repo.

**Open a ticket before any work** that spans more than a couple of tool calls, touches
several files, changes visible behaviour, or could be half-done. Not for questions,
reads, explanations or one-liners.

    tkt new "TITLE" -r "REQUIREMENT" -c "CHECK" [-r .. -c ..]
    tkt met ID N --evidence "WHAT YOU OBSERVED"
    tkt assume ID "WHAT" --breaks "WHAT IF WRONG"
    tkt grill ID --observed .. --cause .. --absence .. --assumption .. --falsify ..
    tkt done ID          # exits non-zero and names the gap if anything is unproved

- **A requirement is TRUE or FALSE once the work is finished**, and every one carries a
  check written up front — a command, or `manual:` / `file:` / `eye:`. `make search
  better` is refused; `searching "budgets" returns the 12 documents containing
  "budget"` is not. Three to six per ticket. Cover the whole ask, including the
  inconvenient part.
- **`--evidence` is what you OBSERVED**, not that you did the thing. `ran the tests` is
  not evidence; `test/search.mjs budgets -> 12 hits` is.
- **A waiver is not a proof.** `tkt waive` needs a reason, and the user's agreement if
  it drops something they asked for. Adding a requirement mid-flight is honest;
  deleting one to make `done` pass is not.
- **The zero exit of `tkt done` is the only thing licensing the words "done",
  "complete", "finished", "working" or "ready".** Never edit ticket files by hand.
- **The grill's five questions are fixed**: observed-or-derived (cite the coordinate and
  the raw value), cause-or-hypothesis, missing-or-merely-unmatched, whose-assumption,
  what-would-falsify-it. A generated grill is unfalsifiable. One that always survives
  is theatre.
- **Labels come from the tool**, not from your own composition: `tkt done` prints
  `[TASK-COMPLETE]` and `[GRILLED]`, `tkt status` prints `[STATUS-UPDATE]` (which
  always carries a number and a direction), `tkt assume` prints `[ASSUMING]`.
  `[TECH-REPORT]` is typed by hand and explains *why* — it changes nothing about what
  is done. Do not label everything; a label on every paragraph is a label on nothing.
- **Stay invisible.** Never narrate ticket mechanics, never show JSON, never ask the
  user to write requirements or review a board. The id is a short prefix on a label.
  Requirements surface twice only: a one-line confirmation if the ask was genuinely
  ambiguous, and at completion where `tkt done` prints them.
