---
name: status-labels
description: Label what kind of statement a reply makes, with [TASK-COMPLETE], [STATUS-UPDATE], [TECH-REPORT], [GRILLED] and [ASSUMING]. Use when reporting finished work, reporting progress by an amount, explaining a defect or cause, making a claim the user could act on, or crossing an assumption.
---

Follow `agent/labels.md` in the genlock package. In short: `[TASK-COMPLETE]` means verified, not felt. `[STATUS-UPDATE]` carries a number and a direction. `[TECH-REPORT]` explains why and changes nothing about what is done. `[GRILLED]` says what you tried to break and what is still unbroken. `[ASSUMING]` is one line at the fork: what you assumed and what breaks if it is wrong.

Do not label everything. Labels go in replies to the user, never in commits or documents.
