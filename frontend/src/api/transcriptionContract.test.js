import { describe, expect, test } from "vitest";
import { normaliseTranscriptionResponse } from "./transcriptionContract";

// "whisper-base" is the shape resolve_model_name() actually produces
// (backend + "-" + size, see app/models/whisper_stt.py); a bare "base"
// is not a value this endpoint can return.
function makeResponse(overrides = {}) {
  return {
    transcript: "tidy the desk",
    model_name: "whisper-base",
    transcription_ms: 812.5,
    audio_duration_s: 3.25,
    ...overrides,
  };
}

describe("normaliseTranscriptionResponse, valid responses", () => {
  test("a complete response normalises to the four validated fields", () => {
    const result = normaliseTranscriptionResponse(makeResponse());

    expect(result).toEqual({
      transcript: "tidy the desk",
      modelName: "whisper-base",
      transcriptionMs: 812.5,
      audioDurationS: 3.25,
    });
  });

  test("an EXPLICITLY empty transcript is valid, a silent recording is not an error", () => {
    const result = normaliseTranscriptionResponse(makeResponse({ transcript: "" }));

    expect(result.transcript).toBe("");
  });

  test("a whitespace-only transcript is a valid string and is not trimmed here", () => {
    const result = normaliseTranscriptionResponse(makeResponse({ transcript: "   " }));

    expect(result.transcript).toBe("   ");
  });

  test("zero timings are valid", () => {
    const result = normaliseTranscriptionResponse(
      makeResponse({ transcription_ms: 0, audio_duration_s: 0 }),
    );

    expect(result.transcriptionMs).toBe(0);
    expect(result.audioDurationS).toBe(0);
  });

  test("the faster-whisper model name is accepted too", () => {
    const result = normaliseTranscriptionResponse(makeResponse({ model_name: "faster-whisper-base" }));

    expect(result.modelName).toBe("faster-whisper-base");
  });

  test("the returned object is a fresh four-field object, not the response itself", () => {
    const response = makeResponse();

    const result = normaliseTranscriptionResponse(response);

    expect(result).not.toBe(response);
    expect(Object.keys(result).sort()).toEqual([
      "audioDurationS",
      "modelName",
      "transcript",
      "transcriptionMs",
    ]);
  });
});

describe("normaliseTranscriptionResponse, the envelope itself", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", [{ transcript: "x" }]],
    ["a string", '{"transcript":"x"}'],
    ["a number", 42],
    ["a boolean", true],
  ])("%s is rejected", (_label, value) => {
    expect(() => normaliseTranscriptionResponse(value)).toThrow(/response must be an object/);
  });

  test("an empty object is rejected, it describes no transcription at all", () => {
    expect(() => normaliseTranscriptionResponse({})).toThrow(/transcript must be a string/);
  });
});

describe("normaliseTranscriptionResponse, transcript", () => {
  test("a MISSING transcript is malformed, never silence", () => {
    const { transcript, ...withoutTranscript } = makeResponse();
    expect(transcript).toBeDefined();

    expect(() => normaliseTranscriptionResponse(withoutTranscript)).toThrow(/transcript must be a string/);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 0],
    ["a boolean", false],
    ["an array", []],
    ["an object", {}],
  ])("a transcript that is %s is rejected", (_label, value) => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ transcript: value }))).toThrow(
      /transcript must be a string/,
    );
  });
});

describe("normaliseTranscriptionResponse, model_name", () => {
  test("a missing model_name is rejected", () => {
    const { model_name, ...withoutModel } = makeResponse();
    expect(model_name).toBeDefined();

    expect(() => normaliseTranscriptionResponse(withoutModel)).toThrow(/model_name must be a non-empty string/);
  });

  test.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["a number", 1],
    ["a boolean", true],
  ])("a model_name that is %s is rejected", (_label, value) => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ model_name: value }))).toThrow(
      /model_name must be a non-empty string/,
    );
  });
});

describe("normaliseTranscriptionResponse, timings", () => {
  test.each(["transcription_ms", "audio_duration_s"])("a missing %s is rejected", (field) => {
    const response = makeResponse();
    delete response[field];

    expect(() => normaliseTranscriptionResponse(response)).toThrow(
      new RegExp(`${field} must be a finite number`),
    );
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["null", null],
    ["a numeric string", "812.5"],
    ["a boolean", true],
    ["an array", [1]],
  ])("a transcription_ms that is %s is rejected", (_label, value) => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ transcription_ms: value }))).toThrow(
      /transcription_ms must be a finite number/,
    );
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["a numeric string", "3.25"],
    ["a boolean", false],
  ])("an audio_duration_s that is %s is rejected", (_label, value) => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ audio_duration_s: value }))).toThrow(
      /audio_duration_s must be a finite number/,
    );
  });

  test("a negative transcription_ms is rejected", () => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ transcription_ms: -0.001 }))).toThrow(
      /transcription_ms must not be negative/,
    );
  });

  test("a negative audio_duration_s is rejected", () => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ audio_duration_s: -1 }))).toThrow(
      /audio_duration_s must not be negative/,
    );
  });
});

describe("normaliseTranscriptionResponse, unexpected fields", () => {
  test("an extra field is rejected, matching the route's own extra=forbid", () => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ truncated: false }))).toThrow(
      /unexpected field\(s\): \["truncated"\]/,
    );
  });

  test("the placeholder contract's duration_ms is rejected rather than silently ignored", () => {
    // The V1 backend deliberately split the placeholder's ambiguous
    // duration_ms into transcription_ms + audio_duration_s. A response
    // still carrying the old field is a version mismatch, not a detail.
    expect(() => normaliseTranscriptionResponse(makeResponse({ duration_ms: 900 }))).toThrow(
      /unexpected field\(s\): \["duration_ms"\]/,
    );
  });

  test("several extra fields are all reported, sorted", () => {
    expect(() =>
      normaliseTranscriptionResponse(makeResponse({ zeta: 1, alpha: 2 })),
    ).toThrow(/unexpected field\(s\): \["alpha","zeta"\]/);
  });

  test("an unexpected field is rejected even when every expected field is valid", () => {
    const response = makeResponse({ transcript: "", confidence: 0.9 });

    expect(() => normaliseTranscriptionResponse(response)).toThrow(/unexpected field/);
  });
});

describe("normaliseTranscriptionResponse, no coercion", () => {
  test("a numeric string is not turned into a number", () => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ transcription_ms: "0" }))).toThrow();
  });

  test("a truthy value is not turned into a transcript", () => {
    expect(() => normaliseTranscriptionResponse(makeResponse({ transcript: 1 }))).toThrow();
  });

  test("valid values are returned byte-for-byte, untrimmed and unrounded", () => {
    const result = normaliseTranscriptionResponse(
      makeResponse({ transcript: "  spaced  ", transcription_ms: 0.1 + 0.2 }),
    );

    expect(result.transcript).toBe("  spaced  ");
    expect(result.transcriptionMs).toBe(0.1 + 0.2);
  });
});
