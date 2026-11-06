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
