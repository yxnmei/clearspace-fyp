"""
Word error rate for the V3 speech-to-text comparison — pure functions,
no model, no I/O, no numpy.

Lives in evaluation/metrics/ alongside detection_evaluation.py and
instance_matching.py, and for the same reason: the scoring rule is the
part of an evaluation most likely to be wrong in a way nobody notices,
so it is separated from the runner and tested on its own.

WHY THE NORMALISATION RULE IS SPELLED OUT RATHER THAN ASSUMED. Whisper
emits punctuation and capitalisation ("The blue jacket was a gift, from
my grandmother."); a hand-written reference transcript does not. Scoring
those against each other with a bare `.lower().split()` counts "gift,"
as a substitution for "gift" and turns almost every word into an error —
which would make BOTH backends look uniformly terrible and, worse, look
indistinguishable. The previous version of compare_stt.py did exactly
that. Every rule below is applied identically to reference and
hypothesis, and the runner records this module's RULE_DESCRIPTION
verbatim in its artefact so a reader can audit what was actually
measured.

WHAT IS DELIBERATELY *NOT* DONE: no stemming, no contraction expansion,
no number-to-word mapping, no synonym table. Each of those is a
judgement call that silently flatters whichever backend happens to
share its convention, and none is standard in WER reporting.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

# Removed outright, anywhere they appear. Sentence punctuation, brackets,
# and both straight and typographic quotation marks — none of it is
# spoken, so none of it should be scored.
PUNCTUATION_TO_REMOVE = ".,!?;:\"()[]{}<>@#$%^&*_+=|\\/~`" + "“”…–—"

# Folded to their ASCII counterparts BEFORE anything is removed, because
# NFKC does not do it. Whisper emits U+2019 in contractions, so "don’t"
# and "don't" are the same spoken word and must tokenise identically —
# treating the curly form as punctuation instead would split it into
# "don" + "t" and score two errors against a reference that typed the
# straight one. The same fold lets the edge-stripping below remove a
# curly ‘quoted’ pair, since it now sees ordinary apostrophes.
APOSTROPHE_EQUIVALENTS = "‘’‚‛\u02bc"
_APOSTROPHE_TABLE = {ord(c): "'" for c in APOSTROPHE_EQUIVALENTS}

# Kept INSIDE a word, stripped from its edges. "don't" and "twenty-one"
# are single spoken tokens and must not be split; a quoted 'word' or a
# dashed --- separator carries nothing.
EDGE_ONLY_CHARACTERS = "'-"

_WHITESPACE_RE = re.compile(r"\s+")
_REMOVE_TABLE = {ord(c): " " for c in PUNCTUATION_TO_REMOVE}

RULE_DESCRIPTION = (
    "NFKC; casefold; "
    f"apostrophe-like characters {APOSTROPHE_EQUIVALENTS!r} folded to \"'\"; punctuation "
    f"{PUNCTUATION_TO_REMOVE!r} replaced with a space; apostrophes and hyphens kept "
    "inside a word and stripped from its edges; whitespace collapsed; split on whitespace. "
    "No stemming, no contraction expansion, no number conversion, no synonyms."
)


class EmptyReferenceError(ValueError):
    """A scored clip has no reference words.

    Its own error rather than a guarded division: WER is errors divided
    by reference length, and with a zero denominator there is no rate to
    report. The obvious "fix" — dividing by max(len, 1) — silently
    returns the hypothesis word count and presents it as a rate, which
    is how a silence clip ends up contributing a WER of 7.0 to a corpus
    average. Silence clips are marked wer_scored=false instead and
    reported on their own terms.
    """


def normalise_for_wer(text: str) -> str:
    """Apply RULE_DESCRIPTION and return the normalised text.

    Raises TypeError on a non-string: a None transcript is a defect in
    whatever produced it, not something to coerce to "".
    """
    if not isinstance(text, str):
        raise TypeError("text must be a str")

    # NFKC first, so a full-width or ligature form is folded to its
    # ordinary counterpart BEFORE the punctuation table is consulted.
    # Apostrophe folding comes next and separately: NFKC leaves U+2019
    # alone, so without this step a curly contraction would be split by
    # the punctuation table below.
    folded = unicodedata.normalize("NFKC", text).casefold().translate(_APOSTROPHE_TABLE)
    despunctuated = folded.translate(_REMOVE_TABLE)

    tokens = []
    for raw in _WHITESPACE_RE.split(despunctuated):
        token = raw.strip(EDGE_ONLY_CHARACTERS)
        if token:
            tokens.append(token)
    return " ".join(tokens)


def tokenise_for_wer(text: str) -> list[str]:
    """The normalised word sequence WER is actually computed over."""
    normalised = normalise_for_wer(text)
    return normalised.split() if normalised else []


@dataclass(frozen=True)
class WordErrorCounts:
    """One clip's alignment result.

    Counts, not just a rate: a backend that drops half a sentence
    (deletions) and one that invents half a sentence (insertions) can
    share a WER while failing in completely different ways, and only one
    of those is acceptable in a field whose text the user then reviews.
    """

    substitutions: int
    deletions: int
    insertions: int
    hits: int
    reference_words: int

    @property
    def errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def wer(self) -> float:
        """Errors per reference word. Can exceed 1.0 when a backend
        inserts more than it gets right — that is real and is not
        clamped."""
        return round(self.errors / self.reference_words, 6)

    def as_dict(self) -> dict:
        return {
            "substitutions": self.substitutions,
            "deletions": self.deletions,
            "insertions": self.insertions,
            "hits": self.hits,
            "reference_words": self.reference_words,
            "errors": self.errors,
            "wer": self.wer,
        }


def word_error_counts(reference: str, hypothesis: str) -> WordErrorCounts:
    """Word-level Levenshtein alignment with an explicit backtrace.

    DETERMINISM. Several alignments can share the minimum cost, and they
    can attribute the same total to different S/D/I splits. The
    backtrace below therefore fixes a preference order — diagonal
    (hit or substitution), then deletion, then insertion — rather than
    taking whichever branch `min()` happens to return. Without that, the
    same two strings could report different S/D/I counts between Python
    versions while the WER stayed identical, and the counts are half the
    point of this function.

    Raises EmptyReferenceError when the reference normalises to nothing.
    """
    ref = tokenise_for_wer(reference)
    hyp = tokenise_for_wer(hypothesis)

    if not ref:
        raise EmptyReferenceError("reference transcript has no words to score against")

    n, m = len(ref), len(hyp)
    # cost[i][j] = edit distance between ref[:i] and hyp[:j]
    cost = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        cost[i][0] = i
    for j in range(m + 1):
        cost[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            substitution = cost[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1)
            deletion = cost[i - 1][j] + 1
            insertion = cost[i][j - 1] + 1
            cost[i][j] = min(substitution, deletion, insertion)

    substitutions = deletions = insertions = hits = 0
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            matched = ref[i - 1] == hyp[j - 1]
            if cost[i][j] == cost[i - 1][j - 1] + (0 if matched else 1):
                if matched:
                    hits += 1
                else:
                    substitutions += 1
                i -= 1
                j -= 1
                continue
        if i > 0 and cost[i][j] == cost[i - 1][j] + 1:
            deletions += 1
            i -= 1
            continue
        # Only an insertion is left; j > 0 is guaranteed by the loop
        # condition plus the two branches above.
        insertions += 1
        j -= 1

    return WordErrorCounts(
        substitutions=substitutions,
        deletions=deletions,
        insertions=insertions,
        hits=hits,
        reference_words=n,
    )


def corpus_wer(counts: Iterable[WordErrorCounts]) -> dict:
    """Aggregate S/D/I over every scored clip, then divide ONCE.

    This is the headline figure, and it is deliberately not the mean of
    the per-clip rates. Mean-of-rates weights a three-word clip exactly
    as heavily as a sixty-word one, so a single misheard word in a short
    clip can move it further than a whole misheard sentence in a long
    one. Both numbers are returned so the difference is visible rather
    than argued about; `mean_per_clip_wer` is reported as a secondary,
    length-biased view and never as the result.

    An empty collection yields nulls, not zeros — "nothing was scored"
    and "nothing was wrong" are not the same claim.
    """
    items = list(counts)
    if not items:
        return {
            "clip_count": 0,
            "substitutions": 0,
            "deletions": 0,
            "insertions": 0,
            "hits": 0,
            "reference_words": 0,
            "errors": 0,
            "corpus_wer": None,
            "mean_per_clip_wer": None,
        }

    substitutions = sum(c.substitutions for c in items)
    deletions = sum(c.deletions for c in items)
    insertions = sum(c.insertions for c in items)
    hits = sum(c.hits for c in items)
    reference_words = sum(c.reference_words for c in items)
    errors = substitutions + deletions + insertions

    return {
        "clip_count": len(items),
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "hits": hits,
        "reference_words": reference_words,
        "errors": errors,
        "corpus_wer": round(errors / reference_words, 6),
        "mean_per_clip_wer": round(sum(c.wer for c in items) / len(items), 6),
    }
