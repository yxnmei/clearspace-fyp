# Ground-truth labels for the evaluation image set

`labels.json` (once populated) is the committed ground truth for the
12–15 curated test images (§3 step 2). Actual image files are gitignored
(`data/test_images/`) — only this labels file, which references them by
filename, is committed. That's deliberate: the labels are small,
reviewable in a diff, and needed for CI-style reruns; the images
themselves are not something to ship in the repo.

## Clutter Image Rating (CIR) caveat — do not silently gloss over this

Frost et al.'s CIR only has **official anchor photos for Bedroom,
Kitchen, and Living Room**. Any image outside those three room types
(desk, wardrobe, storage corner, etc.) is **self-rated** on the same
1–9 scale by visual comparison to the nearest anchor set, not scored
against an official CIR anchor. Record which is which — see
`self_rated: true/false` in the schema below — and say so explicitly in
the dissertation. Do not let a self-rated desk photo get reported
alongside official CIR scores without that caveat; that's exactly the
kind of thing a reviewer catches.

## Schema (see labels.example.json)

```json
{
  "filename": "desk_01.jpg",
  "room_type": "home office desk",
  "cir_score": 6,
  "self_rated": true,
  "ground_truth_items": [
    {"label": "keyboard", "expected_decision": "keep"},
    {"label": "printer", "expected_decision": "sell"}
  ],
  "notes": "cluttered desk, moderate severity"
}
```

`ground_truth_items.expected_decision` is a judgement call made once, by
one person, at labelling time — it feeds the §8 "decision agreement"
metric, not a claim of objective correctness. Note who labelled it and
when in `notes` if more than one person ever contributes labels.
