---
name: ticketed-work
description: Work from a ticket whose requirements were written before the work started, so that "done" is proved rather than asserted. Use at the start of any task spanning more than a couple of tool calls, touching several files, changing visible behaviour, or capable of being half-done — and whenever about to report something complete, finished, working or ready.
---

Use the `tkt` command. If it is not on PATH, use `npx @locklainn/tkt` in its place.

## At the start of the work

Write the definition of done **before** doing any of it:

```
tkt new "the outcome, as a state that will be true" \
  --ask "the user's own words, if short" \
  -r "a statement that will be TRUE or FALSE when this is finished" -c "the command or manual: check that settles it" \
  -r "..." -c "..."
```

`tkt new` refuses vague requirements, and what it refuses is the lesson: `make search
better` names a feeling, `searching "budgets" returns the 12 documents containing
"budget"` names a state. Three to six requirements. They describe the finished state,
never the steps. Cover the whole ask, including the inconvenient part.

**If you cannot write the requirements, you do not yet understand the ask.** Look first
— the files, the git history, a command. Ask the user only where two readings lead to
materially different work, and then batch the questions into one exchange.

## While working

```
tkt met ID N --evidence "test/search.mjs budgets -> 12 hits"   # what you OBSERVED
tkt fail ID N --evidence "..."                                  # tried; did not hold
tkt waive ID N --reason "..."                                   # out of reach, and why
tkt req ID -r "..." -c "..."                                    # discovered mid-flight
tkt assume ID "what you took as given" --breaks "what if wrong"
tkt status ID                                                   # a [STATUS-UPDATE] line
```

`ran the tests` is not evidence. The command and its output is. A waiver is not a
proof. Adding a requirement is honest; deleting one to make `done` pass is not, and
never edit the ticket files by hand.

## Before saying it is done

```
tkt grill ID       # prints the five fixed questions and which are still open
tkt grill ID --observed ".." --cause ".." --absence ".." --assumption ".." --falsify ".."
tkt done ID
```

**`tkt done` exiting zero is the only thing that licenses the words "done",
"complete", "finished", "working" or "ready".** If it refuses, it names the gap: close
the gap, do not route around it. It prints the `[TASK-COMPLETE]`, `[GRILLED]` and
`[ASSUMING]` lines itself — relay those rather than composing your own.

## Stay invisible

The user never opens a ticket and mostly should not know one exists. Do not narrate the
mechanics, show JSON, paste command transcripts, or ask the user to write requirements
or review a board. The id is a short prefix on a label: `[STATUS-UPDATE] ABC-0007 · …`.
Requirements surface twice only — a one-line confirmation if the ask was genuinely
ambiguous, and at completion, where `tkt done` prints them.

Nothing is written into the repository; tickets live in `~/.tkt/<repo>/`.

See `agent/PROTOCOL.md` in the package for the full reasoning behind each rule.
