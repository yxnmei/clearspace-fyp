"""
Unit tests for evaluation/metrics/stt_metrics.py.

Pure functions only — no model, no audio, no I/O. The scoring rule is
the part of an evaluation most likely to be quietly wrong, so it is
tested independently of the runner that consumes it.
"""

from __future__ import annotations

import pytest

from evaluation.metrics.stt_metrics import (
    PUNCTUATION_TO_REMOVE,
    RULE_DESCRIPTION,
    EmptyReferenceError,
    WordErrorCounts,
    corpus_wer,
    normalise_for_wer,
    tokenise_for_wer,
    word_error_counts,
)


# --- normalisation --------------------------------------------------------


def test_lowercases_and_collapses_whitespace():
    assert normalise_for_wer("  The   BLUE\tJacket \n") == "the blue jacket"


def test_strips_sentence_punctuation():
    assert normalise_for_wer("The blue jacket, a gift.") == "the blue jacket a gift"


def test_the_exact_failure_the_old_harness_had():
    """A Whisper-style hypothesis and a hand-written reference must
    normalise to the SAME tokens. The previous WER function only
    lowercased and split, so "gift," scored as a substitution for
    "gift" and nearly every word became an error."""
    reference = "the blue jacket was a gift from my grandmother"
    hypothesis = " The blue jacket was a gift, from my grandmother."

    assert normalise_for_wer(hypothesis) == normalise_for_wer(reference)
    assert word_error_counts(reference, hypothesis).errors == 0


def test_removes_brackets_and_typographic_quotes():
    assert normalise_for_wer("“keep” (the desk) — please…") == "keep the desk please"


@pytest.mark.parametrize("char", list(PUNCTUATION_TO_REMOVE))
def test_every_declared_punctuation_character_is_removed(char):
    assert char not in normalise_for_wer(f"alpha{char}beta")


def test_punctuation_becomes_a_separator_not_a_join():
    """Replaced with a space, not deleted: "desk,chair" is two words."""
    assert tokenise_for_wer("desk,chair") == ["desk", "chair"]


def test_keeps_an_intra_word_apostrophe():
    assert tokenise_for_wer("don't move it") == ["don't", "move", "it"]


def test_keeps_an_intra_word_hyphen():
    assert tokenise_for_wer("twenty-one boxes") == ["twenty-one", "boxes"]


def test_strips_apostrophes_and_hyphens_from_word_edges():
    assert tokenise_for_wer("'quoted' --- word-") == ["quoted", "word"]


def test_applies_nfkc_before_anything_else():
    # Full-width characters fold to their ASCII counterparts.
    assert normalise_for_wer("ＫＥＥＰ") == "keep"


def test_does_not_stem():
    assert normalise_for_wer("boxes") == "boxes"


def test_does_not_expand_contractions():
    assert normalise_for_wer("don't") == "don't"


def test_does_not_convert_numbers():
    assert normalise_for_wer("2019") == "2019"
    assert word_error_counts("twenty nineteen", "2019").errors > 0


def test_empty_and_punctuation_only_input_normalise_to_nothing():
    assert normalise_for_wer("") == ""
    assert normalise_for_wer("   ") == ""
    assert normalise_for_wer("...!?") == ""
    assert tokenise_for_wer("...!?") == []


def test_non_string_raises_rather_than_being_coerced():
    with pytest.raises(TypeError):
        normalise_for_wer(None)


def test_rule_description_is_recorded_verbatim_and_names_what_it_does():
    for fragment in ("NFKC", "casefold", "apostrophes", "hyphens", "No stemming"):
        assert fragment in RULE_DESCRIPTION


# --- alignment counts -----------------------------------------------------


def test_identical_strings_have_no_errors():
    counts = word_error_counts("keep the desk", "keep the desk")
    assert counts.substitutions == 0
    assert counts.deletions == 0
    assert counts.insertions == 0
    assert counts.hits == 3
    assert counts.reference_words == 3
    assert counts.wer == 0.0


def test_pure_substitution():
    counts = word_error_counts("keep the desk", "keep the chair")
    assert (counts.substitutions, counts.deletions, counts.insertions) == (1, 0, 0)
    assert counts.hits == 2


def test_pure_deletion():
    counts = word_error_counts("keep the desk", "keep desk")
    assert (counts.substitutions, counts.deletions, counts.insertions) == (0, 1, 0)


def test_pure_insertion():
    counts = word_error_counts("keep the desk", "keep the big desk")
    assert (counts.substitutions, counts.deletions, counts.insertions) == (0, 0, 1)


def test_combined_errors():
    counts = word_error_counts("keep the desk by the window", "keep a desk near window today")
    assert counts.errors == counts.substitutions + counts.deletions + counts.insertions
    assert counts.hits + counts.substitutions + counts.deletions == counts.reference_words


def test_empty_hypothesis_is_all_deletions():
    counts = word_error_counts("keep the desk", "")
    assert (counts.substitutions, counts.deletions, counts.insertions) == (0, 3, 0)
    assert counts.hits == 0
    assert counts.wer == 1.0


def test_wer_can_exceed_one_and_is_not_clamped():
    counts = word_error_counts("desk", "the big wooden desk in the corner")
    assert counts.wer > 1.0


def test_hits_plus_substitutions_plus_deletions_always_equals_reference_length():
    pairs = [
        ("one two three", "one two three"),
        ("one two three", "one three"),
        ("one two three", "one two three four"),
        ("one two three", "four five six"),
        ("one two three", ""),
        ("a b c d e", "a x c y e z"),
    ]
    for reference, hypothesis in pairs:
        counts = word_error_counts(reference, hypothesis)
        assert counts.hits + counts.substitutions + counts.deletions == counts.reference_words


def test_alignment_is_deterministic_across_repeated_calls():
    """Several alignments can share the minimum cost while splitting
    S/D/I differently; the backtrace fixes a preference order so the
    counts, not just the total, are stable."""
    first = word_error_counts("a b c d", "a x y d")
    for _ in range(20):
        assert word_error_counts("a b c d", "a x y d") == first


def test_counts_distinguish_dropping_from_inventing_at_the_same_wer():
    dropped = word_error_counts("one two three four", "one two")
    invented = word_error_counts("one two three four", "one two three four five six")

    assert dropped.wer == invented.wer
    assert dropped.deletions == 2 and dropped.insertions == 0
    assert invented.insertions == 2 and invented.deletions == 0


def test_normalisation_is_applied_before_alignment():
    assert word_error_counts("keep the desk", "Keep the DESK.").errors == 0


def test_scored_empty_reference_raises_rather_than_dividing():
    with pytest.raises(EmptyReferenceError):
        word_error_counts("", "the model invented this")


def test_punctuation_only_reference_also_raises():
    with pytest.raises(EmptyReferenceError):
        word_error_counts("...", "anything")


def test_as_dict_exposes_every_count():
    counts = word_error_counts("keep the desk", "keep the chair")
    payload = counts.as_dict()
    assert set(payload) == {
        "substitutions",
        "deletions",
        "insertions",
        "hits",
        "reference_words",
        "errors",
        "wer",
    }
    assert payload["errors"] == 1


# --- corpus aggregation ---------------------------------------------------


def test_corpus_wer_divides_once_over_aggregate_totals():
    counts = [
        word_error_counts("one two three four", "one two three five"),  # 1/4
        word_error_counts("alpha beta", "alpha beta"),  # 0/2
    ]
    aggregate = corpus_wer(counts)

    assert aggregate["errors"] == 1
    assert aggregate["reference_words"] == 6
    assert aggregate["corpus_wer"] == pytest.approx(1 / 6, abs=1e-6)


def test_corpus_wer_differs_from_mean_per_clip_wer_and_both_are_reported():
    """The short clip is entirely wrong, the long clip entirely right.
    Mean-of-rates says 50%; corpus WER weights by length and says much
    less. Reporting only the mean would over-weight short clips."""
    short = word_error_counts("no", "yes")
    long = word_error_counts(" ".join(["word"] * 20), " ".join(["word"] * 20))

    aggregate = corpus_wer([short, long])

    assert aggregate["mean_per_clip_wer"] == pytest.approx(0.5, abs=1e-6)
    assert aggregate["corpus_wer"] == pytest.approx(1 / 21, abs=1e-6)
    assert aggregate["corpus_wer"] < aggregate["mean_per_clip_wer"]


def test_corpus_wer_of_nothing_is_null_not_zero():
    """"Nothing was scored" and "nothing was wrong" are different
    claims and must not share a representation."""
    aggregate = corpus_wer([])

    assert aggregate["clip_count"] == 0
    assert aggregate["corpus_wer"] is None
    assert aggregate["mean_per_clip_wer"] is None


def test_corpus_wer_sums_each_error_kind_separately():
    aggregate = corpus_wer(
        [
            WordErrorCounts(substitutions=1, deletions=2, insertions=3, hits=4, reference_words=7),
            WordErrorCounts(substitutions=1, deletions=0, insertions=1, hits=2, reference_words=3),
        ]
    )

    assert aggregate["substitutions"] == 2
    assert aggregate["deletions"] == 2
    assert aggregate["insertions"] == 4
    assert aggregate["hits"] == 6
    assert aggregate["reference_words"] == 10
    assert aggregate["errors"] == 8
    assert aggregate["corpus_wer"] == pytest.approx(0.8, abs=1e-6)


# --- typographic apostrophes ----------------------------------------------


def test_a_curly_and_a_straight_contraction_normalise_identically():
    """Whisper emits U+2019 in contractions; a hand-typed reference uses
    the straight form. Treating the curly one as punctuation would split
    "don’t" into "don" + "t" and score two errors against an identical
    utterance."""
    assert normalise_for_wer("don\u2019t move it") == normalise_for_wer("don't move it")
    assert word_error_counts("don't move it", "Don\u2019t move it.").errors == 0


@pytest.mark.parametrize(
    "curly",
    ["don\u2019t", "don\u2018t", "don\u201at", "don\u201bt", "don\u02bct"],
)
def test_every_apostrophe_equivalent_folds_to_the_straight_form(curly):
    assert tokenise_for_wer(curly) == ["don't"]


def test_curly_quotation_marks_around_a_word_are_stripped_from_its_edges():
    assert tokenise_for_wer("\u2018quoted\u2019 word") == ["quoted", "word"]
    assert tokenise_for_wer("\u201cquoted\u201d word") == ["quoted", "word"]


def test_folding_does_not_split_or_join_a_hyphenated_word():
    assert tokenise_for_wer("twenty-one \u2018boxes\u2019") == ["twenty-one", "boxes"]


def test_a_possessive_survives_folding():
    assert tokenise_for_wer("my grandmother\u2019s jacket") == ["my", "grandmother's", "jacket"]


def test_rule_description_names_the_apostrophe_fold():
    assert "folded" in RULE_DESCRIPTION
    assert "apostrophe-like" in RULE_DESCRIPTION


def test_apostrophe_equivalents_are_not_also_in_the_removal_set():
    """A character cannot both fold to an apostrophe and be deleted as
    punctuation; overlap would make the order of the two tables matter."""
    from evaluation.metrics.stt_metrics import APOSTROPHE_EQUIVALENTS

    assert not (set(APOSTROPHE_EQUIVALENTS) & set(PUNCTUATION_TO_REMOVE))


def test_mean_per_clip_wer_is_documented_as_length_biased():
    import evaluation.metrics.stt_metrics as module

    assert "length-biased" in module.corpus_wer.__doc__
    assert "duration-biased" not in module.corpus_wer.__doc__
