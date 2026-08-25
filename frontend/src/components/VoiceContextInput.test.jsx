import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import VoiceContextInput from "./VoiceContextInput";
import { VOICE_MESSAGES } from "../hooks/useVoiceContext";
import * as client from "../api/client";
import { installRecordingSupport, permissionDeniedError } from "../test/mediaRecorder";

vi.mock("../api/client", () => ({
  transcribeAudio: vi.fn(),
}));

// Same per-test discipline as the hook's own suite: nothing is faked
// globally, so the default browser here cannot record and the fallback
// stays exercised by every test that does not opt in.
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

// A miniature stand-in for the real upload forms: a context textarea
// the component can fill only by calling back, plus a busy flag. This
// is what makes "the transcript never writes context by itself"
// assertable — the state lives outside the component under test.
function Host({ initialContext = "", onBusy = () => {} }) {
  const [context, setContext] = useState(initialContext);
  return (
    <div>
      <label htmlFor="host-context">Context for the AI (optional)</label>
      <textarea id="host-context" value={context} onChange={(e) => setContext(e.target.value)} />
      <VoiceContextInput
        idPrefix="host"
        context={context}
        onApplyTranscript={setContext}
        onBusyChange={onBusy}
      />
    </div>
  );
}

function contextBox() {
  return screen.getByLabelText(/context for the ai/i);
}

function audioFile(type = "audio/wav", name = "note.wav") {
  return new File(["fake audio bytes"], name, { type });
}

function transcribeResolves(transcript) {
  client.transcribeAudio.mockResolvedValue({
    transcript,
    model_name: "whisper-base",
    transcription_ms: 10,
    audio_duration_s: 1,
  });
}

/** Upload an audio file through the component's own file input. */
async function uploadAudio(user, file = audioFile()) {
  await user.upload(screen.getByLabelText(/audio file/i), file);
}

describe("VoiceContextInput — layout and fallbacks", () => {
  test("sits beside the context field without replacing it", () => {
    render(<Host />);
    expect(contextBox()).toBeInTheDocument();
    expect(screen.getByLabelText(/audio file/i)).toBeInTheDocument();
  });

  test("a browser that cannot record still offers the file route and says so", () => {
    render(<Host />);
    expect(screen.queryByRole("button", { name: /record context/i })).not.toBeInTheDocument();
    expect(screen.getByText(/recording is not available in this browser/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/audio file/i)).toBeInTheDocument();
  });

  test("a browser that can record offers the record button", () => {
    track(installRecordingSupport());
    render(<Host />);
    expect(screen.getByRole("button", { name: /record context/i })).toBeInTheDocument();
  });

  test("no transcript panel exists before anything is transcribed", () => {
    render(<Host />);
    expect(screen.queryByLabelText(/transcript to review/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use as context/i })).not.toBeInTheDocument();
  });
});

describe("VoiceContextInput — recording", () => {
  test("recording shows a live status and swaps in a stop button", async () => {
    const user = userEvent.setup();
    track(installRecordingSupport());
    render(<Host />);

    await user.click(screen.getByRole("button", { name: /record context/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/recording/i);
    expect(screen.getByRole("button", { name: /stop recording/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^record context$/i })).not.toBeInTheDocument();
  });

  test("stopping transcribes the recording and opens the review panel", async () => {
    const user = userEvent.setup();
    transcribeResolves("keep the desk by the window");
    const harness = track(installRecordingSupport());
    render(<Host />);

    await user.click(screen.getByRole("button", { name: /record context/i }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /stop recording/i }));
      harness.recorder.last().finish();
    });

    await waitFor(() =>
      expect(screen.getByLabelText(/transcript to review/i)).toHaveValue("keep the desk by the window"),
    );
    expect(contextBox()).toHaveValue("");
  });

  test("the audio file input is disabled while recording", async () => {
    const user = userEvent.setup();
    track(installRecordingSupport());
    render(<Host />);

    await user.click(screen.getByRole("button", { name: /record context/i }));

    expect(screen.getByLabelText(/audio file/i)).toBeDisabled();
  });

  test("a denied microphone keeps the file input usable", async () => {
    const user = userEvent.setup();
    track(installRecordingSupport({ error: permissionDeniedError() }));
    render(<Host />);

    await user.click(screen.getByRole("button", { name: /record context/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(VOICE_MESSAGES.permissionDenied);
    expect(screen.getByLabelText(/audio file/i)).toBeEnabled();
    expect(contextBox()).toHaveValue("");
  });
});

describe("VoiceContextInput — the transcript is never applied automatically", () => {
  test("an arriving transcript leaves an empty context empty", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host />);

    await uploadAudio(user);

    await screen.findByLabelText(/transcript to review/i);
    expect(contextBox()).toHaveValue("");
  });

  test("an arriving transcript leaves TYPED context exactly as it was", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host initialContext="I am downsizing before a move" />);

    await uploadAudio(user);

    await screen.findByLabelText(/transcript to review/i);
    expect(contextBox()).toHaveValue("I am downsizing before a move");
  });

  test("context typed WHILE the request was in flight is not overwritten", async () => {
    const user = userEvent.setup();
    let settle;
    client.transcribeAudio.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<Host />);

    await uploadAudio(user);
    await user.type(contextBox(), "typed while waiting");
    await act(async () => {
      settle({
        transcript: "spoken instead",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
    });

    await screen.findByLabelText(/transcript to review/i);
    expect(contextBox()).toHaveValue("typed while waiting");
  });
});

describe("VoiceContextInput — applying a transcript", () => {
  test("with empty context the action reads Use as context", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host />);

    await uploadAudio(user);

    expect(await screen.findByRole("button", { name: "Use as context" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /replace context/i })).not.toBeInTheDocument();
  });

  test("with existing context the action reads Replace context", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host initialContext="already here" />);

    await uploadAudio(user);

    expect(await screen.findByRole("button", { name: "Replace context" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use as context/i })).not.toBeInTheDocument();
  });

  test("clicking Use as context writes the transcript and closes the panel", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host />);

    await uploadAudio(user);
    await user.click(await screen.findByRole("button", { name: "Use as context" }));

    expect(contextBox()).toHaveValue("tidy the shelf");
    expect(screen.queryByLabelText(/transcript to review/i)).not.toBeInTheDocument();
  });

  test("replacement happens only on the explicit click, never before it", async () => {
    const user = userEvent.setup();
    transcribeResolves("spoken replacement");
    render(<Host initialContext="typed original" />);

    await uploadAudio(user);
    const applyButton = await screen.findByRole("button", { name: "Replace context" });
    expect(contextBox()).toHaveValue("typed original");

    await user.click(applyButton);

    expect(contextBox()).toHaveValue("spoken replacement");
  });

  test("the edited text — not the raw transcript — is what reaches context", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host />);

    await uploadAudio(user);
    const transcriptBox = await screen.findByLabelText(/transcript to review/i);
    await user.clear(transcriptBox);
    await user.type(transcriptBox, "tidy the shelf and the desk");
    await user.click(screen.getByRole("button", { name: "Use as context" }));

    expect(contextBox()).toHaveValue("tidy the shelf and the desk");
  });

  test("an applied transcript is trimmed", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host />);

    await uploadAudio(user);
    const transcriptBox = await screen.findByLabelText(/transcript to review/i);
    await user.clear(transcriptBox);
    await user.type(transcriptBox, "  spaced out  ");
    await user.click(screen.getByRole("button", { name: "Use as context" }));

    expect(contextBox()).toHaveValue("spaced out");
  });

  test("editing the transcript down to whitespace disables applying it", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host />);

    await uploadAudio(user);
    const transcriptBox = await screen.findByLabelText(/transcript to review/i);
    await user.clear(transcriptBox);

    expect(screen.getByRole("button", { name: "Use as context" })).toBeDisabled();
  });

  test("discarding closes the panel and leaves context untouched", async () => {
    const user = userEvent.setup();
    transcribeResolves("tidy the shelf");
    render(<Host initialContext="typed original" />);

    await uploadAudio(user);
    await user.click(await screen.findByRole("button", { name: /discard transcript/i }));

    expect(contextBox()).toHaveValue("typed original");
    expect(screen.queryByLabelText(/transcript to review/i)).not.toBeInTheDocument();
  });
});

describe("VoiceContextInput — blank transcript", () => {
  test("silence is reported honestly and cannot be applied", async () => {
    const user = userEvent.setup();
    transcribeResolves("");
    render(<Host initialContext="typed original" />);

    await uploadAudio(user);

    expect(await screen.findByText(/no speech detected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use as context/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /replace context/i })).not.toBeInTheDocument();
    expect(contextBox()).toHaveValue("typed original");
  });

  test("the blank result can be dismissed", async () => {
    const user = userEvent.setup();
    transcribeResolves("   ");
    render(<Host />);

    await uploadAudio(user);
    await user.click(await screen.findByRole("button", { name: /discard transcript/i }));

    expect(screen.queryByText(/no speech detected/i)).not.toBeInTheDocument();
  });
});

describe("VoiceContextInput — errors", () => {
  test.each([
    ['POST /transcribe failed: 503 {"detail":"transcription is busy"}', VOICE_MESSAGES.busy],
    ['POST /transcribe failed: 503 {"detail":"transcription is unavailable"}', VOICE_MESSAGES.unavailable],
    ['POST /transcribe failed: 415 {"detail":"audio format is not supported"}', VOICE_MESSAGES.unsupportedAudio],
    ['POST /transcribe failed: 413 {"detail":"audio is too long"}', VOICE_MESSAGES.tooLong],
    ["Failed to fetch", VOICE_MESSAGES.failed],
  ])("%s is shown as a concise optional-feature message", async (thrown, expected) => {
    const user = userEvent.setup();
    client.transcribeAudio.mockRejectedValue(new Error(thrown));
    render(<Host initialContext="typed original" />);

    await uploadAudio(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert.textContent).not.toMatch(/\d{3}|detail|POST \//);
    expect(contextBox()).toHaveValue("typed original");
  });

  test("a non-audio file is refused without an upload, keeping context intact", async () => {
    render(<Host initialContext="typed original" />);

    // fireEvent, not userEvent.upload: user-event emulates the browser's
    // own accept-attribute filtering, which would drop this file before
    // the component's own check ever ran.
    fireEvent.change(screen.getByLabelText(/audio file/i), {
      target: { files: [new File(["x"], "room.png", { type: "image/png" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(VOICE_MESSAGES.unsupportedAudio);
    expect(client.transcribeAudio).not.toHaveBeenCalled();
    expect(contextBox()).toHaveValue("typed original");
  });
});

describe("VoiceContextInput — busy reporting", () => {
  test("busy is reported true while transcribing and false once it finishes", async () => {
    const user = userEvent.setup();
    let settle;
    client.transcribeAudio.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const onBusy = vi.fn();
    render(<Host onBusy={onBusy} />);

    await uploadAudio(user);
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));

    await act(async () => {
      settle({
        transcript: "done",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
    });
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  });

  test("busy is reported false again after an error", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockRejectedValue(new Error("Failed to fetch"));
    const onBusy = vi.fn();
    render(<Host onBusy={onBusy} />);

    await uploadAudio(user);

    await screen.findByRole("alert");
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  test("unmounting mid-recording reports idle so the host is never stuck", async () => {
    const user = userEvent.setup();
    track(installRecordingSupport());
    const onBusy = vi.fn();
    const { unmount } = render(<Host onBusy={onBusy} />);

    await user.click(screen.getByRole("button", { name: /record context/i }));
    expect(onBusy).toHaveBeenLastCalledWith(true);

    unmount();

    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  test("unmounting mid-recording releases the microphone", async () => {
    const user = userEvent.setup();
    const harness = track(installRecordingSupport({ trackCount: 2 }));
    const { unmount } = render(<Host />);

    await user.click(screen.getByRole("button", { name: /record context/i }));
    unmount();

    for (const t of harness.media.last().tracks) expect(t.stopCount).toBe(1);
  });
});

describe("VoiceContextInput — a malformed 200 is not silence", () => {
  test.each([
    ["a missing transcript", { model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1 }],
    ["a non-string transcript", { transcript: 7, model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1 }],
    ["an unexpected extra field", { transcript: "hi", model_name: "whisper-base", transcription_ms: 1, audio_duration_s: 1, truncated: true }],
  ])("%s shows the generic failure, never No speech detected", async (_label, response) => {
    const user = userEvent.setup();
    client.transcribeAudio.mockResolvedValue(response);
    render(<Host initialContext="typed original" />);

    await uploadAudio(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(VOICE_MESSAGES.failed);
    expect(screen.queryByText(/no speech detected/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/transcript to review/i)).not.toBeInTheDocument();
    expect(contextBox()).toHaveValue("typed original");
  });

  test("the message names no field, value or contract module", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockResolvedValue({ transcript: null, model_name: "whisper-base" });
    render(<Host />);

    await uploadAudio(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/transcriptionContract|model_name|must be|null/);
  });
});

describe("VoiceContextInput — a failed recorder", () => {
  test("keeps its message and opens no review panel when the trailing events arrive", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockResolvedValue({
      transcript: "must never be requested",
      model_name: "whisper-base",
      transcription_ms: 1,
      audio_duration_s: 1,
    });
    const harness = track(installRecordingSupport());
    render(<Host initialContext="typed original" />);

    await user.click(screen.getByRole("button", { name: /record context/i }));
    await act(async () => {
      // error -> dataavailable -> stop, as the specification permits.
      harness.recorder.last().fail();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(VOICE_MESSAGES.microphoneUnavailable);
    expect(screen.queryByLabelText(/transcript to review/i)).not.toBeInTheDocument();
    expect(client.transcribeAudio).not.toHaveBeenCalled();
    expect(contextBox()).toHaveValue("typed original");
  });

  test("returns the form to a non-busy state so recording can be retried", async () => {
    const user = userEvent.setup();
    const onBusy = vi.fn();
    const harness = track(installRecordingSupport());
    render(<Host onBusy={onBusy} />);

    await user.click(screen.getByRole("button", { name: /record context/i }));
    await act(async () => {
      harness.recorder.last().fail();
    });

    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: /record context/i })).toBeEnabled();
  });
});
