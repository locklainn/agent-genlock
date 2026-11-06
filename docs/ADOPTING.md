# Adopting genlock in an existing repository

For an agent or a person setting genlock up where work is already under way.

## 1. Set it up

    genlock install --check     # what would change, nothing written
    genlock init --private      # or --shared; rules, hooks, MCP server and skills for this repository
    genlock doctor              # confirms it took

Rules go into whichever agent files exist (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, ...), between markers, and nothing else in those files changes. Hooks go into `.claude/settings.json`, the server into `.mcp.json`. Read the diff, and commit them only if the repository's owner wants that.

**`--private` or `--shared`?** Records are permanent append-only logs, and they quote people. Removing something from a committed log means rewriting git history.

- `--private` keeps records on this machine, excluded from git. Use it for a public repository or one with sensitive material. All worktrees on this machine share them, but they have no history, no backup, and do not reach other machines.
- `--shared` commits records with your work, so they have history and travel with the repository.

**Does anything here need a clean working tree?** Scheduled jobs, deploy scripts and checks that refuse a dirty tree will see `.genlock/` files. Check before the first record is written. Also check anything that fails on a new top-level folder.

## 2. Let goals emerge

There is nothing to fill in first. Run `genlock orient` and get on with the work. When it makes a goal clear, record it in the owner's words:

    genlock goal add "THE GOAL" --user-said "THEIR WORDS"

## 3. Bring existing notes across, one document at a time

If the repository has handoff documents, status notes or plans, do not convert them in bulk. Split each one:

| what the document holds | where it goes |
|---|---|
| What to do next, in order | `genlock goal next G "..."` |
| Anything with a date | `genlock due ID YYYY-MM-DD`, or `genlock goal next G "..." --due YYYY-MM-DD` |
| What matters most, in one strict order | `genlock rank`, `genlock rank ID --to N` |
| Where the work stands | `genlock update T "..."`, 600 characters at most |
| Decisions and who made them | `genlock decide ID "..." --user-said ".."` |
| Decisions reversed | `genlock decide ID "..." --supersedes N`, so nobody re-adds them |
| What must not be done | `genlock forbid ID "..." --lifted-by ".."` |
| Questions only the owner can answer | `genlock ask user "..." --about G`, one each |
| Stray processes, suspect uncommitted files | `genlock hazard T "..." --verify ".."` |
| Dormant work | `genlock goal park G --waiting-on ".."` |
| Findings, measurements, reference, how-to | **Stays in a file.** `genlock ref ID PATH --why ".."` points at it |

A record is state, not knowledge. If a document is mostly findings, it stays a document and only its next steps come across.

**Leave these alone:**
- Finished documents. Closing a ticket as done needs evidence and a grill, and inventing them defeats the tool.
- Reference material, and anything that is still true when the work is finished.
- Any file another file points at by path, especially hashed or generated documents. Search for references before moving anything, and search for bare filenames as well as paths.

**Verify before porting.** A document's claims are claims. Check that processes it names still exist, that its status date means someone actually re-checked it, and that it does not contradict itself.

**Keep the original until you trust the port.** Then test it: start a fresh session with no other context, have it run `genlock orient` and `genlock continue`, and ask what is next, what must not be done, what waits on the owner, and what is due. Compare the answers to the document. Anything it cannot answer was lost, and that is what the trial is for. Do not rely on genlock alone for a real deadline until this has passed.

## 4. Work

The rules installed in step 1 cover daily use. `genlock help` lists every command.

- "Start a handoff" means `genlock checkpoint`.
- "Continue the goal" means `genlock continue`.
- Claim before editing when other sessions may be working here.

If a repository has existing conventions for status documents, update them to say what moved, so two systems do not both claim to be the source of truth.

## Undoing it

    npm uninstall -g @locklainn/genlock

Then delete the block between the `genlock` markers in the agent files, the `genlock` entries in `.claude/settings.json` and `.mcp.json`, the skills it installed in `.claude/skills/`, and `.genlock/`. Each is plain text, and none of this touches your code.
