---
name: reviews
description: Keep files the user should look at findable. Use whenever asking the user to read, check or approve a file, plan, draft, report or page.
---

Use the `genlock` command, or the genlock MCP tools if connected. If it is not on PATH, use `npx @locklainn/genlock`.

## Reviews: files the user should look at

A path mentioned in a reply scrolls away, so a request to review is a record.

    genlock review PATH --why "WHAT TO LOOK AT, AND WHAT YOU NEED FROM THEM" [--about GOAL|TICKET]
    genlock review list
    genlock review done R [--note ".."]

- **Whenever you ask the user to read, check or approve a file, register it in the same turn.** Plans, drafts, reports, generated pages, screenshots. A URL works too. Say so in your reply as usual; this is what keeps it findable afterwards.
- **`--why` is the question, not a description.** "Is the rate in section 2 what you meant?" rather than "the plan".
- **Only for what needs their eyes.** Not every file you touched.
- **When they have answered,** `genlock review done R`, and record what they decided with `genlock decide`.
