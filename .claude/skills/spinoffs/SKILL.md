---
name: spinoffs
description: Move a tangent into its own session. Use when new work comes up mid-thread that deserves separate attention, when rabbit-holing, or when the user asks to split work off.
---

Use the `genlock` command, or the genlock MCP tools if connected. If it is not on PATH, use `npx @locklainn/genlock`.

## Spin-offs: move a tangent into its own session

When new work comes up mid-thread, do not start it here. It muddles the thread. Offer to move it.

**Before finishing each response, ask whether a tangent came up that deserves its own session:** real work, separate from the current goal's next step, more than a quick fix. Do not manufacture one. Most responses have none.

    genlock claim PARENT --path WHAT_THIS_SESSION_IS_TOUCHING
    genlock spinoff propose "THE OUTCOME" --parent PARENT --why ".." --context "WHAT THE NEW AGENT NEEDS TO KNOW" \
      --path WHAT_IT_WILL_TOUCH --needs none --blocks none

Then follow the verdict, which is the tool's and not yours:

- **SAFE:** offer it in one line: *"I can kick off a spinoff so you can work from there: THE OUTCOME."* Wait. On a yes: `genlock spinoff launch ID --user-said "THEIR WORDS"`. On a no: `genlock spinoff park ID "why"`.
- **NOT SAFE:** do not offer a launch. Say the ticket is recorded and why it must wait, in one line. It overlaps this work, needs this work's unfinished result, or would leave this session waiting for it.

**Never launch without the user's yes.** It opens a window and spends their usage in parallel. `--needs` is what it needs from this session's unfinished work; `--blocks` is what this session needs from it. Answer both honestly, because the check is only as good as these declarations and the paths.
