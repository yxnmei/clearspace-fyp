import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeclutterUploadForm from "./DeclutterUploadForm";
import { VOICE_MESSAGES } from "../hooks/useVoiceContext";
import * as client from "../api/client";

// The form itself still never talks to the API — this mock exists only
// because the voice input it now mounts does. No MediaRecorder fake is
// installed in this file: these tests exercise the audio-file route,
// which is exactly the fallback a browser without recording gets.
vi.mock("../api/client", () => ({
  transcribeAudio: vi.fn(),
}));

function makeFile(name = "room.jpg") {
  return new File(["fake image bytes"], name, { type: "image/jpeg" });
}

beforeEach(() => {
  // jsdom does not implement object URLs.
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview-url");
  global.URL.revokeObjectURL = vi.fn();
  vi.clearAllMocks();
});

function audioFile() {
  return new File(["fake audio bytes"], "note.wav", { type: "audio/wav" });
}

function transcribeResolves(transcript) {
  client.transcribeAudio.mockResolvedValue({
    transcript,
    model_name: "whisper-base",
    transcription_ms: 10,
    audio_duration_s: 1,
  });
}

describe("DeclutterUploadForm", () => {
  test("submit is disabled without a selected image", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /analyse room/i })).toBeDisabled();
  });

  test("selecting an image enables submission", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());

    expect(screen.getByRole("button", { name: /analyse room/i })).toBeEnabled();
  });

  test("typed context is passed to submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const file = makeFile();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), file);
    await user.type(screen.getByLabelText(/context for the ai/i), "downsizing before a move");
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "downsizing before a move" });
  });

  test("uploading shows truthful progress copy and disables submission", () => {
    render(<DeclutterUploadForm status="uploading" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(/up to two minutes/i);
    expect(screen.getByRole("button", { name: /analysing/i })).toBeDisabled();
    expect(screen.getByLabelText(/room photo/i)).toBeDisabled();
  });

  test("upload failure displays an alert while retaining the form", async () => {
    const user = userEvent.setup();
    const file = makeFile();
    render(<DeclutterUploadForm status="error" error="Declutter upload failed" onSubmit={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/declutter upload failed/i);
    // The form itself is still present and usable — nothing was discarded.
    await user.upload(screen.getByLabelText(/room photo/i), file);
    expect(screen.getByRole("button", { name: /analyse room/i })).toBeEnabled();
  });

  test("inputs have accessible labels", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/room photo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toBeInTheDocument();
  });

  test("the room preview has alt text once a file is selected", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());

    expect(screen.getByRole("img")).toHaveAccessibleName(/room photo/i);
  });
});

describe("DeclutterUploadForm — voice context", () => {
  test("the voice input is mounted beside the context textarea, not instead of it", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/context for the ai/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/audio file/i)).toBeInTheDocument();
  });

  test("an applied transcript reaches onSubmit as the context", async () => {
    const user = userEvent.setup();
    transcribeResolves("I am downsizing before a move");
    const onSubmit = vi.fn();
    const file = makeFile();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), file);
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await user.click(await screen.findByRole("button", { name: "Use as context" }));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "I am downsizing before a move" });
  });

  test("an EDITED transcript is what reaches onSubmit", async () => {
    const user = userEvent.setup();
    transcribeResolves("downsizing");
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    const transcriptBox = await screen.findByLabelText(/transcript to review/i);
    await user.clear(transcriptBox);
    await user.type(transcriptBox, "downsizing and being decisive");
    await user.click(screen.getByRole("button", { name: "Use as context" }));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "downsizing and being decisive" });
  });

  test("a pending transcript the user never applied is NOT submitted", async () => {
    const user = userEvent.setup();
    transcribeResolves("never applied");
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await screen.findByLabelText(/transcript to review/i);
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    // Transcription has finished, so submitting is allowed — but the
    // unapplied transcript contributes nothing.
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: null });
  });

  test("typed context survives an unapplied transcript arriving next to it", async () => {
    const user = userEvent.setup();
    transcribeResolves("spoken instead");
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "typed original");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await screen.findByLabelText(/transcript to review/i);
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "typed original" });
  });

  test("submission is disabled while transcription is running, and enabled again after", async () => {
    const user = userEvent.setup();
    let settle;
    client.transcribeAudio.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    expect(screen.getByRole("button", { name: /analyse room/i })).toBeEnabled();

    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await waitFor(() => expect(screen.getByRole("button", { name: /analyse room/i })).toBeDisabled());

    await act(async () => {
      settle({
        transcript: "done now",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /analyse room/i })).toBeEnabled());
  });

  test("a voice failure leaves the typed context and the form intact", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockRejectedValue(new Error("Failed to fetch"));
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "typed original");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());

    expect(await screen.findByText(VOICE_MESSAGES.failed)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "typed original" });
  });

  test("the voice controls are disabled while the room upload itself is running", () => {
    render(<DeclutterUploadForm status="uploading" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/audio file/i)).toBeDisabled();
  });
});
