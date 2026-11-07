<!-- BEGIN genlock (managed by `genlock install`; edits inside are overwritten) -->

## Label what KIND of statement you are making

Used in replies to the user, never in commits, documents or code comments.

| label | answers | for |
|---|---|---|
| `[TASK-COMPLETE]` | *is it done?* | finished and VERIFIED: the check passed, the count moved. Not "I have finished typing" |
| `[STATUS-UPDATE]` | *what moved?* | the work advanced or failed, by an amount. Always a number and a direction |
| `[TECH-REPORT]` | *why?* | a defect, a cause, a limitation. It changes nothing about what is done |
| `[GRILLED]` | *what survived?* | on every `[TASK-COMPLETE]` and every claim the user could act on: what you tried to break, what survived, what is still unbroken |
| `[ASSUMING]` | *what did you take for granted?* | one line, at the fork, as you cross it: what you assumed and what breaks if it is wrong |

**The test between `[STATUS-UPDATE]` and `[TECH-REPORT]`: can you put a number and a direction in it?**

    [STATUS-UPDATE]  422 pages -> 474. FY2025's budget pages now classify.
    [TECH-REPORT]    they did not before because the money pattern required cents.

**Do not label everything.** A label on every paragraph is a label on nothing. Ordinary answers and working notes carry none. A withdrawal gets `[STATUS-UPDATE]` as loudly as an advance.

**Five fixed questions, asked of your own claim before it reaches the user:** (1) Observed, or derived? Cite the coordinate and raw value. (2) Is the cause a measurement, or a hypothesis? (3) Missing, or merely unmatched? A grep that found nothing is a statement about the instrument. (4) Whose assumption is this, and did anybody choose it? (5) What would falsify it? A grill that always survives is theatre.

## Tickets: done is proved, not asserted

`genlock` holds a definition of done written *before* the work, and refuses completion until each part has evidence.

**Open a ticket before any work** that spans more than a couple of tool calls, touches several files, changes visible behaviour, or could be half-done. Not for questions, reads, explanations or one-liners.

    genlock new "TITLE" -r "REQUIREMENT" -c "CHECK" [-r .. -c ..] [--goal G]
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

## Goals: what the work is for, and what is next

Goals are the one layer the user sees, because only the user can say what they are.

    genlock goal list                       # also what to run when asked "what are the goals?"
    genlock goal add "TITLE" --user-said ".."
    genlock goal propose "TITLE" --why ".."
    genlock goal accept G --user-said ".."  |  genlock goal reject G --user-said ".."
    genlock goal next G "NEXT THING"  |  genlock goal next G --done N  |  genlock goal next G --still-right
    genlock goal next G "THING" --due YYYY-MM-DD  |  genlock goal next G --move N --to M
    genlock goal park G --waiting-on ".."  |  genlock goal unpark G
    genlock goal update G "WHAT MOVED"
    genlock rank  |  genlock rank ID --to N  |  genlock rank ID --before OTHER
    genlock due ID YYYY-MM-DD  |  genlock due ID --clear
    genlock ask user "QUESTION" --about G  |  genlock answer Q "ANSWER" --user-said ".."
    genlock link TICKET G
    genlock goal done G --evidence ".." --user-said ".."

- **Never make the user set a goal first.** Get on with what they ask. Goals are something you notice as the work goes, not a form to fill in.
- **When the work makes a goal clear, record it in their words,** using what they actually asked for as `--user-said`, and mention it in one line so they can correct it. If it is your own idea rather than something they asked for, `goal propose` it and ask.
- **The user owns goals.** Their words make one active or close it. If they say this project needs none, `genlock goal none --user-said ".."`.
- **Noticed a new goal in the work?** `goal propose`, then ask in one line. Do not create it on your own judgement, and do not ask more than once.
- **Keep next things current.** They are the first thing a fresh session reads, so when work finishes or the plan changes, change them.
- **A decision that is the user's goes on their list** with `genlock ask user`, one question each. It surfaces at every session start until answered. Do not decide it yourself.
- **Anything with a date gets a due date,** with `--due` or `genlock due`. A date in prose is one nobody is reminded of.
- **Goals and tasks have one strict order: `genlock rank`.** No two share a place. Work from the top unless told otherwise, and when the user says what matters most, move it there rather than noting it in prose.
- **Link every ticket to a goal** when one fits.
- **Status questions are answered from the records**, not from memory: `goal list`, `goal show G`. Progress is counted from tickets, never typed.

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

## Coordination: several agents, one repository

Declare what you are touching, stay out of what others hold, and never make anyone wait.

    genlock claim ID --path src/search --resource site-build
    genlock claims                          # who holds what
    genlock check --path P                  # ask without taking
    genlock release ID
    genlock ask TICKET|any "QUESTION"  |  genlock answer Q "ANSWER"  |  genlock inbox

- **Claim before editing** when other sessions may be working here. A resource is any shared thing that is not a file: a build slot, a port, a database. Ending a ticket releases its claim.
- **A refused claim means pick other work.** Do not wait for it and do not work around it. A claim is a lease that lapses if its session stops working, so a dead agent cannot hold anything for long.
- **Ask, then carry on.** A question reaches its target at their next tool call, and the answer reaches you the same way. Nobody blocks. For status, read the records instead of asking.
- **Answer questions briefly** at your next stopping point.
- **In a shared tree, stage and commit by path.** Never `git stash`, `checkout`, `switch`, `restore`, `clean`, `reset --hard`, `add -A` or `commit -a` while another session is working: they destroy or sweep up its uncommitted work.
- **Never release another session's claim** unless that session is gone, and say why with `--reason`.

## Reviews: files the user should look at

A path mentioned in a reply scrolls away, so a request to review is a record.

    genlock review PATH --why "WHAT TO LOOK AT, AND WHAT YOU NEED FROM THEM" [--about GOAL|TICKET]
    genlock review list
    genlock review done R [--note ".."]

- **Whenever you ask the user to read, check or approve a file, register it in the same turn.** Plans, drafts, reports, generated pages, screenshots. A URL works too. Say so in your reply as usual; this is what keeps it findable afterwards.
- **`--why` is the question, not a description.** "Is the rate in section 2 what you meant?" rather than "the plan".
- **Only for what needs their eyes.** Not every file you touched.
- **When they have answered,** `genlock review done R`, and record what they decided with `genlock decide`.

## Spin-offs: move a tangent into its own session

When new work comes up mid-thread, do not start it here. It muddles the thread. Offer to move it.

**Before finishing each response, ask whether a rabbit hole came up that deserves its own session:** real work that can run in isolation from what you are doing, separate from the current goal's next step, more than a quick fix. Moving it keeps this session's context small, which saves tokens. Do not manufacture one. Most responses have none.

    genlock claim PARENT --path WHAT_THIS_SESSION_IS_TOUCHING
    genlock spinoff propose "THE OUTCOME" --parent PARENT --why ".." --context "WHAT THE NEW AGENT NEEDS TO KNOW" \
      --path WHAT_IT_WILL_TOUCH --needs none --blocks none

Then follow the verdict, which is the tool's and not yours:

- **SAFE:** offer it in one line: *"I can kick off a spinoff so you can work from there: THE OUTCOME."* Wait. On a yes: `genlock spinoff launch ID --user-said "THEIR WORDS"`. On a no: `genlock spinoff park ID "why"`.
- **NOT SAFE:** do not offer a launch. Say the ticket is recorded and why it must wait, in one line. It overlaps this work, needs this work's unfinished result, or would leave this session waiting for it.

**Never launch without the user's yes.** It opens a new session, in a pane beside this one in the Mac app or a terminal window elsewhere, and spends their usage in parallel. Everything the new agent needs must be in `--context`, the ticket and the goal, because it starts with none of this conversation. `--needs` is what it needs from this session's unfinished work; `--blocks` is what this session needs from it. Answer both honestly, because the check is only as good as these declarations and the paths.

<!-- END genlock -->
