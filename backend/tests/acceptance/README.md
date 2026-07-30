# Acceptance tests — Validation

**"Are we building the right product?"** Human-judged against real
requirements. This is where the module's Testing Peer Review deliverable
lives (Week 14/18 per the module handbook) — Likert-scale questions sent
to reviewers, answered on an agree/partially-agree/neither/partially-disagree/disagree scale.

Per §6: draft these **as soon as there's a testable interface**, not the
week they're due — the whole point is having enough runway left to act
on what reviewers say. Questions below are a first draft, written now so
they exist; revise them once there's an actual UI to react to, but don't
let "we'll write these later" become "we wrote these the night before
the deadline."

## Draft questions (v0 — revise once a UI exists to test against)

1. *I could easily understand how to use the interface to get a
   decluttering recommendation for my space.*
2. *When the system suggested Keep/Sell/Donate/Discard for an item, the
   reason given made sense to me even when I disagreed with the label.*
3. *I felt in control of the final decision — overriding a suggestion
   was easy to find and easy to do.*

Each answered: Strongly agree / Partially agree / Neither / Partially
disagree / Strongly disagree, plus a free-text "why" field — the *why*
on a disagree answer is worth more than the rating itself.

## Recording responses

Put raw responses in `evaluation/results/acceptance_review_<date>.json`
(gitignored, per §4) — not in this file. Summarise findings and what
changed as a result in the dev log (`DEVLOG.md`), since "we gathered
feedback" without "and here's what we changed because of it" doesn't
satisfy §6's actual intent.
