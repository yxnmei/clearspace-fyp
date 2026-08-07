"""
§2 / §3 step 4: Whisper (base) vs faster-whisper — marked "run early this
time" in §2. Needs a small set of short audio context clips with manual
transcripts as ground truth (data/audio_clips/, gitignored — record
reference transcripts in evaluation/labels/audio_labels.json, committed,
same pattern as image labels).

Compares: word error rate (rough, via simple normalized string diff —
this project doesn't need a full WER library for ~10 short clips),
latency, and model load time (faster-whisper's CTranslate2 backend
trades load time differently than the reference implementation, worth
recording even though accuracy is the headline metric).

Usage (once app/models/whisper_stt.py's faster-whisper path exists):
    python -m evaluation.scripts.compare_stt
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from app.models.whisper_stt import transcribe
from evaluation.scripts.run_dirs import new_run_dir


def normalized_word_error_rate(reference: str, hypothesis: str) -> float:
    """Simple word-level Levenshtein-based WER — adequate at this project's
    scale (~10 short clips); not a substitute for a real WER library at
    larger scale."""
    ref_words = reference.lower().split()
    hyp_words = hypothesis.lower().split()

    # standard DP edit distance over words
    dp = [[0] * (len(hyp_words) + 1) for _ in range(len(ref_words) + 1)]
    for i in range(len(ref_words) + 1):
        dp[i][0] = i
    for j in range(len(hyp_words) + 1):
        dp[0][j] = j
    for i in range(1, len(ref_words) + 1):
        for j in range(1, len(hyp_words) + 1):
            cost = 0 if ref_words[i - 1] == hyp_words[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)

    return round(dp[-1][-1] / max(len(ref_words), 1), 3)


def run_comparison(audio_labels: list[dict], audio_dir: Path) -> dict:
    rows = []
    for entry in audio_labels:
        audio_path = audio_dir / entry["filename"]
        if not audio_path.exists():
            continue
        audio_bytes = audio_path.read_bytes()

        whisper_result = transcribe(audio_bytes, model_name="whisper-base")
        faster_whisper_result = transcribe(audio_bytes, model_name="faster-whisper-base")

        rows.append(
            {
                "filename": entry["filename"],
                "reference_transcript": entry["reference_transcript"],
                "whisper_base": {
                    "text": whisper_result.text,
                    "wer": normalized_word_error_rate(entry["reference_transcript"], whisper_result.text),
                    "duration_ms": whisper_result.duration_ms,
                },
                "faster_whisper_base": {
                    "text": faster_whisper_result.text,
                    "wer": normalized_word_error_rate(entry["reference_transcript"], faster_whisper_result.text),
                    "duration_ms": faster_whisper_result.duration_ms,
                },
            }
        )

    return {"ts": datetime.now(timezone.utc).isoformat(), "rows": rows}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-labels", type=Path, default=Path("evaluation/labels/audio_labels.json"))
    parser.add_argument("--audio-dir", type=Path, default=Path("data/audio_clips"))
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label whisper-vs-faster",
    )
    args = parser.parse_args()

    with args.audio_labels.open(encoding="utf-8") as f:
        audio_labels = json.load(f)

    report = run_comparison(audio_labels, args.audio_dir)

    run_dir = new_run_dir(label=args.label)
    out_path = run_dir / "compare_stt.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")


if __name__ == "__main__":
    main()
