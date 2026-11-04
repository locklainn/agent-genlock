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
