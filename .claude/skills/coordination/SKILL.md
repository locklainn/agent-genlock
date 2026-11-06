---
name: coordination
description: Keep concurrent agents out of each other's way, and pass questions between sessions. Use when other sessions may be working in this repository, before editing shared files or using a shared resource, when an edit or git command is blocked, or to ask another session something.
---

Use the `genlock` command, or the genlock MCP tools if connected. If it is not on PATH, use `npx @locklainn/genlock`.

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
