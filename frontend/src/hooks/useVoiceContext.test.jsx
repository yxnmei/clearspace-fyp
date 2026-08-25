import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VOICE_MESSAGES, useVoiceContext } from "./useVoiceContext";
import * as client from "../api/client";
import {
  installGetUserMedia,
  installMediaRecorder,
  installRecordingSupport,
  permissionDeniedError,
} from "../test/mediaRecorder";

vi.mock("../api/client", () => ({
  transcribeAudio: vi.fn(),
}));

// Every fake installed by a test is registered here and removed
// afterwards, so the NEXT test starts in a jsdom that has neither
// MediaRecorder nor navigator.mediaDevices — which is what makes the
// unsupported-browser path testable at all.
let installed = [];

function track(harness) {
  installed.push(harness);
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  installed = [];
});

afterEach(() => {
  for (const harness of installed.reverse()) harness.restore();
  installed = [];
});

function transcribeResolves(transcript, extra = {}) {
  client.transcribeAudio.mockResolvedValue({
    transcript,
    model_name: "whisper-base",
    transcription_ms: 12.5,
    audio_duration_s: 1.5,
    ...extra,
  });
}

/** A promise the test resolves by hand, for in-flight/staleness cases. */
function deferredResponse() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  client.transcribeAudio.mockReturnValue(promise);
  return { resolve: (value) => settle(value) };
}

function audioFile(type = "audio/wav", name = "note.wav") {
  return new File(["fake audio bytes"], name, { type });
}

/** Start a recording and let getUserMedia + recorder.start() settle. */
async function startRecording(result) {
  await act(async () => {
    await result.current.startRecording();
  });
}

describe("useVoiceContext — feature detection", () => {
  test("reports recording unsupported when the browser has no MediaRecorder", () => {
    const { result } = renderHook(() => useVoiceContext());
    expect(result.current.recordingSupported).toBe(false);
  });

  test("reports recording unsupported when getUserMedia is missing even though MediaRecorder exists", () => {
    track(installMediaRecorder({ supportedTypes: ["audio/webm"] }));
    const { result } = renderHook(() => useVoiceContext());
    expect(result.current.recordingSupported).toBe(false);
  });

  test("reports recording supported when both halves are present", () => {
    track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());
    expect(result.current.recordingSupported).toBe(true);
  });

  test("startRecording in an unsupported browser explains the fallback and calls no API", async () => {
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.recordingUnsupported);
    expect(result.current.isBusy).toBe(false);
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });
});

describe("useVoiceContext — MIME selection", () => {
  test("picks the first candidate the browser says it supports", async () => {
    const harness = track(installRecordingSupport({ supportedTypes: ["audio/webm"] }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    // "audio/webm;codecs=opus" is preferred but unsupported here.
    expect(harness.recorder.last().requestedMimeType).toBe("audio/webm");
  });

  test("prefers the opus variant when the browser supports it", async () => {
    const harness = track(
      installRecordingSupport({ supportedTypes: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] }),
    );
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(harness.recorder.last().requestedMimeType).toBe("audio/webm;codecs=opus");
  });

  test("falls back to a Safari-style type rather than assuming webm", async () => {
    const harness = track(installRecordingSupport({ supportedTypes: ["audio/mp4"] }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(harness.recorder.last().requestedMimeType).toBe("audio/mp4");
  });

  test("asks for no explicit type when the browser supports none of the candidates", async () => {
    const harness = track(installRecordingSupport({ supportedTypes: [] }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(harness.recorder.last().requestedMimeType).toBeNull();
  });
});

describe("useVoiceContext — recording lifecycle", () => {
  test("start moves to a visible recording state and marks the hook busy", async () => {
    track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(result.current.status).toBe("recording");
    expect(result.current.isRecording).toBe(true);
    expect(result.current.isBusy).toBe(true);
  });

  test("stopping joins every chunk into ONE blob and posts it once", async () => {
    transcribeResolves("tidy the desk");
    const harness = track(installRecordingSupport({ supportedTypes: ["audio/webm"] }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      result.current.stopRecording();
      harness.recorder.last().finish({ chunks: [["one"], ["two"], ["three"]] });
    });

    await waitFor(() => expect(result.current.pendingTranscript).toBe("tidy the desk"));
    expect(client.transcribeAudio).toHaveBeenCalledTimes(1);

    const { audioBlob } = client.transcribeAudio.mock.calls[0][0];
    expect(audioBlob).toBeInstanceOf(Blob);
    expect(audioBlob.size).toBe("onetwothree".length);
    // Codec parameters are stripped — the backend allowlists the bare type.
    expect(audioBlob.type).toBe("audio/webm");
  });

  test("the transcript lands as PENDING review state, never applied anywhere", async () => {
    transcribeResolves("put the books on the shelf");
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      result.current.stopRecording();
      harness.recorder.last().finish();
    });

    await waitFor(() => expect(result.current.hasPendingTranscript).toBe(true));
    expect(result.current.pendingTranscript).toBe("put the books on the shelf");
    expect(result.current.status).toBe("idle");
    expect(result.current.isBusy).toBe(false);
  });

  test("a recording that captured no chunks is reported honestly, not transcribed", async () => {
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      result.current.stopRecording();
      harness.recorder.last().finish({ chunks: [] });
    });

    expect(result.current.error).toBe(VOICE_MESSAGES.emptyRecording);
    expect(result.current.hasPendingTranscript).toBe(false);
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });

  test("a recorder-level failure surfaces a fallback message and stops the microphone", async () => {
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });

    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);
    expect(result.current.isBusy).toBe(false);
    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });

  test("stopRecording is a no-op when nothing is recording", () => {
    track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    act(() => {
      result.current.stopRecording();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});

// The MediaRecorder specification permits error -> dataavailable ->
// stop. The fake's fail() models exactly that sequence, so these tests
// fail against a lifecycle that only reports the error without
// invalidating the take.
describe("useVoiceContext — a recorder error is terminal", () => {
  test("the trailing stop event never starts a transcription", async () => {
    transcribeResolves("this must never be requested");
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });

    expect(client.transcribeAudio).not.toHaveBeenCalled();
    expect(result.current.hasPendingTranscript).toBe(false);
  });

  test("chunks delivered AFTER the error are discarded, not assembled into a blob", async () => {
    transcribeResolves("nope");
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      // A generous final buffer flush — none of it may be uploaded.
      harness.recorder.last().fail({ chunks: [["aaa"], ["bbb"], ["ccc"]] });
    });

    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });

  test("chunks recorded BEFORE the error are discarded too", async () => {
    transcribeResolves("nope");
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().emitData(["good audio"]);
      harness.recorder.last().fail();
    });

    expect(client.transcribeAudio).not.toHaveBeenCalled();
    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);
  });

  test("the microphone-unavailable message survives the later dataavailable and stop events", async () => {
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });
    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);

    // More trailing events from the same dead recorder.
    await act(async () => {
      harness.recorder.last().emitData(["late"]);
      harness.recorder.last().onstop?.({});
    });

    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);
    expect(result.current.status).toBe("idle");
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });

  test("tracks are stopped exactly once across the whole failure sequence", async () => {
    const harness = track(installRecordingSupport({ trackCount: 2 }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });

  test("the elapsed timer is cleared exactly once, on the error itself", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    const before = clearIntervalSpy.mock.calls.length;
    await act(async () => {
      harness.recorder.last().fail();
    });

    // Exactly one clear for this take: the trailing stop must not
    // re-enter the release path.
    expect(clearIntervalSpy.mock.calls.length).toBe(before + 1);
    expect(result.current.elapsedSeconds).toBe(0);
    clearIntervalSpy.mockRestore();
  });

  test("stopRecording after a failure does nothing — the take is already gone", async () => {
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });
    act(() => {
      result.current.stopRecording();
    });

    expect(client.transcribeAudio).not.toHaveBeenCalled();
    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);
  });

  test("a failed take does not block the next one", async () => {
    transcribeResolves("the second take");
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });
    expect(result.current.isBusy).toBe(false);

    await startRecording(result);
    await act(async () => {
      result.current.stopRecording();
      harness.recorder.last().finish();
    });

    await waitFor(() => expect(result.current.pendingTranscript).toBe("the second take"));
    expect(client.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  test("ORDINARY stop still collects every chunk and transcribes exactly once", async () => {
    transcribeResolves("a good take");
    const harness = track(installRecordingSupport({ supportedTypes: ["audio/webm"], trackCount: 2 }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().emitData(["one"]);
      result.current.stopRecording();
      harness.recorder.last().finish({ chunks: [["two"], ["three"]] });
    });

    await waitFor(() => expect(result.current.pendingTranscript).toBe("a good take"));
    expect(client.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(client.transcribeAudio.mock.calls[0][0].audioBlob.size).toBe("onetwothree".length);
    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });

  test("discard after a failure stays a clean no-op", async () => {
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });
    act(() => {
      result.current.discard();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("idle");
    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });

  test("unmount after a failure writes no state and stops nothing twice", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = track(installRecordingSupport());
    const { result, unmount } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      harness.recorder.last().fail();
    });
    unmount();

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("useVoiceContext — microphone permission", () => {
  test("a denied permission keeps the other routes open and starts nothing", async () => {
    track(installRecordingSupport({ error: permissionDeniedError() }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.permissionDenied);
    expect(result.current.status).toBe("idle");
    expect(result.current.isBusy).toBe(false);
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });

  test("an insecure-origin SecurityError is treated as a denial too", async () => {
    track(installRecordingSupport({ error: permissionDeniedError("SecurityError") }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.permissionDenied);
  });

  test("a device failure is reported as an unavailable microphone, not a denial", async () => {
    track(installRecordingSupport({ error: permissionDeniedError("NotFoundError") }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);
  });

  test("after a denial the hook is free again — a later attempt is not stuck busy", async () => {
    track(installRecordingSupport({ error: permissionDeniedError() }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.permissionDenied);
    expect(result.current.isBusy).toBe(false);
  });

  test("a construction failure releases the stream that was already granted", async () => {
    const harness = track(
      installRecordingSupport({ constructorError: new Error("no recorder for you") }),
    );
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.microphoneUnavailable);
    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });
});

describe("useVoiceContext — microphone release", () => {
  test("every track is stopped on a normal stop", async () => {
    transcribeResolves("something");
    const harness = track(installRecordingSupport({ trackCount: 2 }));
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    await act(async () => {
      result.current.stopRecording();
      harness.recorder.last().finish();
    });

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });

  test("every track is stopped when the component unmounts mid-recording", async () => {
    const harness = track(installRecordingSupport({ trackCount: 2 }));
    const { result, unmount } = renderHook(() => useVoiceContext());

    await startRecording(result);
    unmount();

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
    expect(harness.recorder.last().stopCount).toBe(1);
  });

  test("every track is stopped when the recording is discarded", async () => {
    const harness = track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await startRecording(result);
    act(() => {
      result.current.discard();
    });

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
    expect(result.current.status).toBe("idle");
  });

  test("a permission granted AFTER unmount still releases its tracks", async () => {
    const harness = track(installRecordingSupport({ deferred: true }));
    const { result, unmount } = renderHook(() => useVoiceContext());

    let started;
    act(() => {
      started = result.current.startRecording();
    });
    unmount();
    await act(async () => {
      harness.media.grant();
      await started;
    });

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
    // The recorder was never constructed — the operation was abandoned.
    expect(harness.recorder.instances).toHaveLength(0);
  });

  test("the recording timer is cleared on unmount", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    track(installRecordingSupport());
    const { result, unmount } = renderHook(() => useVoiceContext());

    await startRecording(result);
    const before = clearIntervalSpy.mock.calls.length;
    unmount();

    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(before);
    clearIntervalSpy.mockRestore();
  });

  test("the elapsed counter ticks while recording and resets on discard", async () => {
    vi.useFakeTimers();
    try {
      track(installRecordingSupport());
      const { result } = renderHook(() => useVoiceContext());

      await act(async () => {
        await result.current.startRecording();
      });
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.elapsedSeconds).toBe(3);

      act(() => {
        result.current.discard();
      });
      expect(result.current.elapsedSeconds).toBe(0);

      // Nothing is left ticking after the discard.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.elapsedSeconds).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useVoiceContext — audio file upload", () => {
  test("an accepted audio file is posted straight to transcription", async () => {
    transcribeResolves("from a file");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile("audio/wav"));
    });

    expect(client.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(result.current.pendingTranscript).toBe("from a file");
  });

  test("file upload works in a browser that cannot record at all", async () => {
    transcribeResolves("fallback route");
    const { result } = renderHook(() => useVoiceContext());
    expect(result.current.recordingSupported).toBe(false);

    await act(async () => {
      await result.current.transcribeFile(audioFile("audio/mpeg", "note.mp3"));
    });

    expect(result.current.pendingTranscript).toBe("fallback route");
  });

  test("a codec parameter on the declared type is tolerated", async () => {
    transcribeResolves("ok");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile("audio/webm;codecs=opus", "note.webm"));
    });

    expect(client.transcribeAudio).toHaveBeenCalledTimes(1);
  });

  test("a non-audio file is rejected locally, without an upload", async () => {
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(new File(["x"], "room.png", { type: "image/png" }));
    });

    expect(result.current.error).toBe(VOICE_MESSAGES.unsupportedAudio);
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });

  test("a file with no declared type is rejected locally", async () => {
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(new File(["x"], "note", { type: "" }));
    });

    expect(result.current.error).toBe(VOICE_MESSAGES.unsupportedAudio);
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });

  test("no file at all is a silent no-op", async () => {
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(null);
    });

    expect(result.current.error).toBeNull();
    expect(client.transcribeAudio).not.toHaveBeenCalled();
  });
});

describe("useVoiceContext — blank transcripts", () => {
  test("an empty transcript becomes a visible blank result, not an error", async () => {
    transcribeResolves("");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });

    expect(result.current.hasPendingTranscript).toBe(true);
    expect(result.current.isPendingBlank).toBe(true);
    expect(result.current.error).toBeNull();
  });

  test("a whitespace-only transcript is blank too", async () => {
    transcribeResolves("   \n  ");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });

    expect(result.current.isPendingBlank).toBe(true);
    expect(result.current.pendingTranscript).toBe("");
  });

  test("silence requires the server to SAY so — an explicit empty transcript, in a complete response", async () => {
    transcribeResolves("");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });

    expect(result.current.isPendingBlank).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useVoiceContext — malformed 200 responses", () => {
  // A 200 is not proof of a usable body. None of these describes a
  // silent recording, so none of them may be presented as one.
  const MALFORMED = [
    ["a transcript field that is missing entirely", { model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1 }],
    ["a transcript that is null", { transcript: null, model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1 }],
    ["a transcript that is a number", { transcript: 0, model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1 }],
    ["a transcript that is an object", { transcript: { text: "hi" }, model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1 }],
    ["a missing model_name", { transcript: "hi", transcription_ms: 1, audio_duration_s: 1 }],
    ["a blank model_name", { transcript: "hi", model_name: "   ", transcription_ms: 1, audio_duration_s: 1 }],
    ["a missing transcription_ms", { transcript: "hi", model_name: "whisper-base", audio_duration_s: 1 }],
    ["a non-finite transcription_ms", { transcript: "hi", model_name: "whisper-base", transcription_ms: Number.NaN, audio_duration_s: 1 }],
    ["a negative audio_duration_s", { transcript: "hi", model_name: "whisper-base", transcription_ms: 1, audio_duration_s: -1 }],
    ["a numeric-string duration", { transcript: "hi", model_name: "whisper-base", transcription_ms: "1", audio_duration_s: 1 }],
    ["an unexpected extra field", { transcript: "hi", model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1, truncated: false }],
    ["the placeholder contract's duration_ms", { transcript: "hi", model_name: "whisper-base", duration_ms: 900 }],
    ["an empty object", {}],
    ["an array", [{ transcript: "hi" }]],
    ["a bare string", "tidy the desk"],
    ["null", null],
  ];

  test.each(MALFORMED)("%s produces the fixed generic failure message", async (_label, response) => {
    client.transcribeAudio.mockResolvedValue(response);
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });

    expect(result.current.error).toBe(VOICE_MESSAGES.failed);
  });

  test.each(MALFORMED)("%s creates no pending transcript and is never called silence", async (_label, response) => {
    client.transcribeAudio.mockResolvedValue(response);
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });

    expect(result.current.hasPendingTranscript).toBe(false);
    expect(result.current.pendingTranscript).toBeNull();
    expect(result.current.isPendingBlank).toBe(false);
  });

  test("no validation detail — no field name, value or module prefix — reaches the message", async () => {
    client.transcribeAudio.mockResolvedValue({ transcript: 7, model_name: "whisper-base", secret_field: "x" });
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });

    const shown = result.current.error;
    expect(shown).toBe(VOICE_MESSAGES.failed);
    expect(shown).not.toMatch(/transcriptionContract|transcript|model_name|secret_field|must be/);
  });

  test("the hook is free again after a malformed response — a later valid one works", async () => {
    client.transcribeAudio.mockResolvedValue({ model_name: "whisper-base" });
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    expect(result.current.error).toBe(VOICE_MESSAGES.failed);
    expect(result.current.isBusy).toBe(false);

    transcribeResolves("recovered fine");
    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    expect(result.current.pendingTranscript).toBe("recovered fine");
    expect(result.current.error).toBeNull();
  });

  test("a malformed response arriving after a discard changes nothing at all", async () => {
    const deferred = deferredResponse();
    const { result } = renderHook(() => useVoiceContext());

    let inFlight;
    act(() => {
      inFlight = result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));
    act(() => {
      result.current.discard();
    });

    await act(async () => {
      deferred.resolve({ nonsense: true });
      await inFlight;
    });

    expect(result.current.error).toBeNull();
    expect(result.current.hasPendingTranscript).toBe(false);
  });
});

describe("useVoiceContext — error mapping", () => {
  async function failWith(message) {
    client.transcribeAudio.mockRejectedValue(new Error(message));
    const { result } = renderHook(() => useVoiceContext());
    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    return result;
  }

  test("415 asks for another recording or file", async () => {
    const result = await failWith('POST /transcribe failed: 415 {"detail":"audio format is not supported"}');
    expect(result.current.error).toBe(VOICE_MESSAGES.unsupportedAudio);
  });

  test("a container mismatch maps to the same record-again message", async () => {
    const result = await failWith(
      'POST /transcribe failed: 415 {"detail":"audio does not match its declared format"}',
    );
    expect(result.current.error).toBe(VOICE_MESSAGES.unsupportedAudio);
  });

  test("400 maps to the same record-again message", async () => {
    const result = await failWith('POST /transcribe failed: 400 {"detail":"audio could not be read"}');
    expect(result.current.error).toBe(VOICE_MESSAGES.unsupportedAudio);
  });

  test("413 says the clip is too long", async () => {
    const result = await failWith('POST /transcribe failed: 413 {"detail":"audio is too long"}');
    expect(result.current.error).toBe(VOICE_MESSAGES.tooLong);
  });

  test("a busy 503 asks the user to wait and retry", async () => {
    const result = await failWith('POST /transcribe failed: 503 {"detail":"transcription is busy"}');
    expect(result.current.error).toBe(VOICE_MESSAGES.busy);
  });

  test("an unavailable 503 points back at typed context", async () => {
    const result = await failWith('POST /transcribe failed: 503 {"detail":"transcription is unavailable"}');
    expect(result.current.error).toBe(VOICE_MESSAGES.unavailable);
  });

  test("a network failure offers a retry and promises context is untouched", async () => {
    const result = await failWith("Failed to fetch");
    expect(result.current.error).toBe(VOICE_MESSAGES.failed);
  });

  test("no message ever contains a status code, a response body or a stack trace", async () => {
    const bodies = [
      'POST /transcribe failed: 415 {"detail":"audio format is not supported"}',
      'POST /transcribe failed: 500 {"detail":"Traceback: app/services/transcription_service.py"}',
      'POST /transcribe failed: 503 {"detail":"transcription is unavailable"}',
    ];

    for (const body of bodies) {
      const result = await failWith(body);
      const shown = result.current.error;
      expect(shown).toBeTruthy();
      expect(Object.values(VOICE_MESSAGES)).toContain(shown);
      expect(shown).not.toMatch(/\d{3}/);
      expect(shown).not.toMatch(/detail|Traceback|transcription_service|POST \//);
    }
  });

  test("a failed transcription leaves no pending transcript behind", async () => {
    const result = await failWith("Failed to fetch");
    expect(result.current.hasPendingTranscript).toBe(false);
    expect(result.current.isBusy).toBe(false);
  });
});

describe("useVoiceContext — one operation at a time", () => {
  test("a second file while one is in flight is refused as busy, not queued", async () => {
    const deferred = deferredResponse();
    const { result } = renderHook(() => useVoiceContext());

    let first;
    act(() => {
      first = result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));

    await act(async () => {
      await result.current.transcribeFile(audioFile("audio/mp4", "second.m4a"));
    });
    expect(result.current.error).toBe(VOICE_MESSAGES.busy);
    expect(client.transcribeAudio).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({
        transcript: "first one",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
      await first;
    });
    expect(result.current.pendingTranscript).toBe("first one");
  });

  test("startRecording while transcribing is refused as busy", async () => {
    deferredResponse();
    track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    act(() => {
      result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));

    await startRecording(result);

    expect(result.current.error).toBe(VOICE_MESSAGES.busy);
    expect(result.current.status).toBe("transcribing");
  });

  test("a double click on record opens the microphone only once", async () => {
    const harness = track(installRecordingSupport({ deferred: true }));
    const { result } = renderHook(() => useVoiceContext());

    let first;
    let second;
    act(() => {
      first = result.current.startRecording();
      second = result.current.startRecording();
    });
    await act(async () => {
      harness.media.grant();
      await Promise.all([first, second]);
    });

    expect(harness.media.calls).toHaveLength(1);
    expect(harness.recorder.instances).toHaveLength(1);
  });
});

describe("useVoiceContext — stale responses", () => {
  test("a response that lands after a discard cannot resurrect a pending transcript", async () => {
    const deferred = deferredResponse();
    const { result } = renderHook(() => useVoiceContext());

    let inFlight;
    act(() => {
      inFlight = result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));

    act(() => {
      result.current.discard();
    });
    await act(async () => {
      deferred.resolve({
        transcript: "too late to matter",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
      await inFlight;
    });

    expect(result.current.hasPendingTranscript).toBe(false);
    expect(result.current.pendingTranscript).toBeNull();
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  test("a rejection that lands after a discard shows no error", async () => {
    let reject;
    client.transcribeAudio.mockReturnValue(
      new Promise((_resolve, r) => {
        reject = r;
      }),
    );
    const { result } = renderHook(() => useVoiceContext());

    let inFlight;
    act(() => {
      inFlight = result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));

    act(() => {
      result.current.discard();
    });
    await act(async () => {
      reject(new Error("POST /transcribe failed: 503 {}"));
      await inFlight;
    });

    expect(result.current.error).toBeNull();
    expect(result.current.hasPendingTranscript).toBe(false);
  });

  test("after discarding an in-flight request the hook is free to start another", async () => {
    const deferred = deferredResponse();
    const { result } = renderHook(() => useVoiceContext());

    let inFlight;
    act(() => {
      inFlight = result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));
    act(() => {
      result.current.discard();
    });

    transcribeResolves("the second one");
    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    expect(result.current.pendingTranscript).toBe("the second one");

    // The abandoned first response still cannot overwrite it.
    await act(async () => {
      deferred.resolve({
        transcript: "the abandoned one",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
      await inFlight;
    });
    expect(result.current.pendingTranscript).toBe("the second one");
  });

  test("a response that lands after unmount writes no state", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const deferred = deferredResponse();
    const { result, unmount } = renderHook(() => useVoiceContext());

    let inFlight;
    act(() => {
      inFlight = result.current.transcribeFile(audioFile());
    });
    await waitFor(() => expect(result.current.isTranscribing).toBe(true));
    unmount();

    await act(async () => {
      deferred.resolve({
        transcript: "nobody is listening",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
      await inFlight;
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("useVoiceContext — pending transcript editing", () => {
  test("the pending transcript can be edited before it is applied", async () => {
    transcribeResolves("tidy the desk");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    act(() => {
      result.current.editPendingTranscript("tidy the desk and the shelf");
    });

    expect(result.current.pendingTranscript).toBe("tidy the desk and the shelf");
  });

  test("clearing the box while editing is NOT reported as silence — the panel stays a live edit", async () => {
    transcribeResolves("tidy the desk");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    act(() => {
      result.current.editPendingTranscript("   ");
    });

    // "No speech detected" describes what the MODEL returned. The user
    // emptying the box is mid-edit, not a transcription result.
    expect(result.current.isPendingBlank).toBe(false);
    expect(result.current.hasPendingTranscript).toBe(true);
    expect(result.current.pendingTranscript).toBe("   ");
  });

  test("a silent result stays flagged silent even after the user types into it", async () => {
    transcribeResolves("");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    expect(result.current.isPendingBlank).toBe(true);

    act(() => {
      result.current.discard();
    });
    expect(result.current.isPendingBlank).toBe(false);
  });

  test("discard clears the pending transcript and any error", async () => {
    transcribeResolves("tidy the desk");
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    act(() => {
      result.current.discard();
    });

    expect(result.current.pendingTranscript).toBeNull();
    expect(result.current.hasPendingTranscript).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("starting a new recording clears the previous pending transcript", async () => {
    transcribeResolves("first take");
    track(installRecordingSupport());
    const { result } = renderHook(() => useVoiceContext());

    await act(async () => {
      await result.current.transcribeFile(audioFile());
    });
    expect(result.current.pendingTranscript).toBe("first take");

    await startRecording(result);

    expect(result.current.hasPendingTranscript).toBe(false);
  });
});
