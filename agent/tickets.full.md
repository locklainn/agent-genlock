# Ticketed work: requirements first, and `done` is proved rather than asserted

**This block is the whole protocol. Paste it into `CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, or any agent's system prompt.** It assumes the `genlock` command is on
PATH (`npx @locklainn/genlock`, `npm i -g @locklainn/genlock`, or a copied checkout).

---

## Why this exists

Agents report work finished before it is finished. Not from dishonesty — from having
no definition of finished to check against. "I have written the extractor" and "the
extractor works" are indistinguishable from the inside, and the second is what gets
said.

The fix is not more care. It is a **definition of done written before the work
starts**, and a tool that refuses to accept completion until each part of it has
recorded evidence. The refusal is mechanical, because a rule you check by reading
lasts until the next session.

**A consequence worth stating plainly: you cannot write requirements for an ask you
do not understand.** So this also forces the understanding to happen at the front,
where it is cheap, instead of surfacing as a wrong deliverable at the end.

## The loop

    genlock new "TITLE" -r "REQUIREMENT" -c "CHECK" [-r .. -c ..]   before starting
    genlock met ID N --evidence "WHAT YOU OBSERVED"                 as each one lands
    genlock assume ID "WHAT" --breaks "WHAT IF WRONG"                at a fork you cross
    genlock grill ID --observed .. --cause .. --absence .. --assumption .. --falsify ..
    genlock done ID                                                  it may refuse

`genlock done` exits non-zero and names the gap if any requirement is unproved or the
grill is unanswered. **Its zero exit is the only thing that licenses the words "done",
"complete", "finished", "working" or "ready".** Say them on your own authority and you
are guessing.

## 1. Open a ticket BEFORE the work, not after

**Open one when** the ask will take more than one or two tool calls, touches more than
one file, changes behaviour anyone else will see, or has any way of being half-done.

**Do not open one for** a question, a file read, an explanation, a one-line fix, or
anything where "done" is self-evident in the same breath as the request. A ticket per
trivial exchange makes the tickets worthless, and the whole point is that the eye can
find the ones that matter.

Put the user's own words in `--ask "..."` when they are short. The ticket then carries
what was actually requested next to what you decided it meant, which is where those
two silently diverge.

## 2. A requirement is a statement that will be TRUE or FALSE, and a check is how you find out

The tool rejects vague requirements, and what it rejects is worth internalising rather
than working around:

| refused | why | write instead |
|---|---|---|
| `make search better` | "better" is a feeling, and nothing here is observable | `searching "budgets" returns the 12 documents containing "budget"` |
| `handle empty input` | "handle" names no outcome | `an empty corpus exits zero and writes a 0-row index` |
| `refactor the parser` | an activity, not a state | `every existing parser test passes and no call site changed` |

**Every requirement carries a `-c` check written before the work.** A command whose
exit code or output settles it, or a human check prefixed `manual:` / `file:` /
`eye:`. A requirement with no check is a wish, and the tool says so.

**Three to six requirements is usually right.** One is usually the ask restated. A
dozen is usually the implementation plan wearing a disguise — requirements describe
the finished state, never the steps to reach it.

**Cover the whole ask, including the part you find inconvenient.** Requirements you
wrote yourself, that you also mark met yourself, are trivially gameable, and the only
thing standing against that is that `genlock done` prints them to the user at the moment
you claim completion. Easy requirements become visible exactly then.

## 3. Work from the ticket, and record evidence as each requirement lands

`--evidence` is **what you observed**, not that you did the thing. `ran the tests` is
not evidence. `test/search.mjs budgets -> 12 hits` is. Quote the command and its
output, the cell and its value, the count before and after.

- `genlock met ID N --evidence "..."` — proved.
- `genlock fail ID N --evidence "..."` — tried and it did not hold. Record it; a failure
  recorded is worth more than a requirement quietly reworded until it passes.
- `genlock waive ID N --reason "..."` — out of reach, with why. **A waiver is not a
  proof**, it is reported separately for that reason, and it needs the user's
  agreement if it removes something they asked for.
- `genlock req ID -r ".." -c ".."` — a requirement discovered mid-flight. Adding one is
  normal and honest. Deleting one to make `done` pass is not.

**Never edit the ticket JSON directly.** The refusal is the product; routing around it
by hand leaves a ticket that says done and a thing that is not.

## 4. Assumptions get named at the fork, as you cross it

    genlock assume ID "fiscal years, not calendar; the sheet says neither" \
      --breaks "every figure here shifts by one year"

At the moment you cross it — not as a question up front before either of you knew
enough to answer it, and not as a confession at the end once the work is built on it.
`--breaks` is required, because an assumption with no stated consequence cannot be
weighed.

**Prefer looking to asking.** If the files, the git history or a command can answer
it, go and find out instead of asking the user. Ask only where two readings would lead
to materially different work, and then batch the questions into one exchange rather
than running an interview.

## 5. The grill: five fixed questions, answered before done

    genlock grill ID          # prints the five and which are still open

| field | the question |
|---|---|
| `--observed` | Observed, or derived? Cite the coordinate and the raw value. |
| `--cause` | Is any cause stated here a measurement, or a hypothesis? |
| `--absence` | Anything reported missing that my instrument only failed to match? |
| `--assumption` | Which assumption here is mine, that nobody chose? |
| `--falsify` | What one check, document or number would falsify this? |

The list is fixed and does not adapt to the ticket. A grill you generate per task is
unfalsifiable — nothing stops you inventing five easy questions and passing. Every
item here is a mistake that actually happens:

1. **Observed or derived.** An instrument that reformats data before you see it is
   part of the finding. If you cannot give the command and its output, the cell and
   its value, the line and its number, you have not checked it.
2. **Cause or hypothesis.** The number is a fact; the explanation for why it moved is
   not, however obvious, and it gets labelled as a hypothesis every time.
3. **Missing or unmatched.** A grep that found nothing, a query with no rows, a test
   that never fired, a pattern that refused — each is a statement about your tooling,
   not about the world. Go and look directly before reporting an absence.
4. **Whose assumption.** A default taken because it was convenient is yours, and it
   gets named as yours rather than presented as how things are.
5. **What would falsify it.** If nothing would, it is not a claim — it is a feeling
   with a figure in it.

**A grill that always survives is theatre.** It earns its place only because it
sometimes withdraws the claim. Most grilling is invisible anyway: it happens before the
claim reaches the user, so the usual product is a weaker and more accurate sentence
with no label on it at all.

## 6. Status reporting comes FROM the ticket

The tool writes the label; do not compose one by hand.

| label | answers | when |
|---|---|---|
| `[TASK-COMPLETE]` | *is it done?* | printed by `genlock done`, never typed. It means measured, not felt |
| `[STATUS-UPDATE]` | *what moved?* | `genlock status ID`. The work advanced or failed, **by an amount** — a number and a direction |
| `[TECH-REPORT]` | *why?* | a defect, a cause, a limitation. Typed by hand; it changes nothing about what is done |
| `[ASSUMING]` | *what did you take for granted?* | printed by `genlock assume` |
| `[GRILLED]` | *what survived?* | printed by `genlock done` |

**`[STATUS-UPDATE]` and `[TECH-REPORT]` are the pair that gets confused.** "The town
changed the table format after FY2023" is not a status update — it explains why a count
did not move. **The count moving is the status.** The test is whether you can put a
number and a direction in it:

    [STATUS-UPDATE]  422 pages -> 474. FY2025's budget pages now classify.
    [TECH-REPORT]    they did not before because the money pattern required cents,
                     and the warrant prints round dollars.

**The discipline is in NOT labelling everything.** A label on every paragraph is a
label on nothing. Ordinary answers, questions and working notes carry none. And a
withdrawal gets `[STATUS-UPDATE]` as loudly as an advance — a claim quietly dropped is
worse than one never made.

## 7. Stay invisible

The user should never open a ticket, and mostly should not know one exists.

- **Do not narrate the mechanics.** No "opening a ticket", no "marking requirement 2
  met", no ticket JSON, no command transcripts. Run them and move on.
- **Show requirements at exactly two moments**: a one-line confirmation of what you are
  about to build, if the ask was ambiguous enough that getting it wrong would waste
  real work — and at completion, where `genlock done` prints them itself.
- **The ticket id is a short prefix on a label**, nothing more: `[STATUS-UPDATE]
  ABC-0007 · ...`.
- **Never ask the user to write requirements, prioritise a board, or review a ticket.**
  Writing them from the ask and the codebase is the job. If you genuinely cannot,
  the ask is ambiguous and the honest move is one batched question — not a ticket
  handed back.
- **Records live in `.genlock/` and merge cleanly.** Each is an append-only file with a random
  id, so tickets never conflict across branches. Commit them with the work, or with `genlock sync`.
