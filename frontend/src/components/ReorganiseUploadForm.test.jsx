import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import ReorganiseUploadForm from "./ReorganiseUploadForm";
import { VOICE_MESSAGES } from "../hooks/useVoiceContext";
import * as client from "../api/client";

// Mocked only because the voice input this form now mounts calls it —
// the form itself still never talks to the API. No MediaRecorder fake
// is installed here, so these tests run in the same non-recording
// browser a fallback user has, exercising the audio-file route.
vi.mock("../api/client", () => ({
  transcribeAudio: vi.fn(),
}));

beforeEach(() => {
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  global.URL.revokeObjectURL = vi.fn();
  vi.clearAllMocks();
});

function pngFile(name = "room.png") {
  return new File(["fake"], name, { type: "image/png" });
}

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

describe("ReorganiseUploadForm", () => {
  test("submit is disabled until a file is chosen", async () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /analyse room/i })).toBeDisabled();
  });

  test("choosing a PNG file enables submit and shows a preview", async () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/room photo/i);
    await userEvent.upload(input, pngFile());
    expect(screen.getByRole("button", { name: /analyse room/i })).toBeEnabled();
    expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument();
  });

  test("choosing an unsupported file type shows an error and keeps submit disabled", () => {
    // Uses fireEvent directly, not userEvent.upload: user-event's own
    // upload() emulates the real browser file PICKER, which already
    // filters by the input's accept attribute before this component's
    // code ever runs — that's a real browser behaviour, not this
    // component's own validation. fireEvent bypasses that picker
    // emulation so this test exercises OUR defense-in-depth check
    // (relevant for drag-and-drop or a browser that doesn't enforce
    // accept), not user-event's.
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/room photo/i);
    const webp = new File(["fake"], "room.webp", { type: "image/webp" });
    fireEvent.change(input, { target: { files: [webp] } });

    expect(screen.getByRole("alert")).toHaveTextContent(/PNG or JPEG/i);
    expect(screen.getByRole("button", { name: /analyse room/i })).toBeDisabled();
  });

  test("submitting calls onSubmit with the file and trimmed context", async () => {
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);
    const file = pngFile();
    await userEvent.upload(screen.getByLabelText(/room photo/i), file);
    await userEvent.type(screen.getByLabelText(/context for the ai/i), "  keep the desk by the window  ");
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "keep the desk by the window" });
  });

  test("blank context is submitted as null", async () => {
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);
    await userEvent.upload(screen.getByLabelText(/room photo/i), pngFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse room/i }));
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: null });
  });

  test("shows a status message while analysing and disables the form", () => {
    render(<ReorganiseUploadForm phase="analysing" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/analysing your room/i);
    expect(screen.getByLabelText(/room photo/i)).toBeDisabled();
  });

  test("shows an upload error as an alert, allowing retry", () => {
    render(<ReorganiseUploadForm phase="upload" error="Reorganise upload failed" onSubmit={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/reorganise upload failed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/try again/i);
  });
});

describe("ReorganiseUploadForm — voice context", () => {
  test("the voice input is mounted beside the context textarea, not instead of it", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/context for the ai/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/audio file/i)).toBeInTheDocument();
  });

  test("an applied transcript reaches onSubmit as the context", async () => {
    const user = userEvent.setup();
    transcribeResolves("keep the desk by the window");
    const onSubmit = vi.fn();
    const file = pngFile();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), file);
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await user.click(await screen.findByRole("button", { name: "Use as context" }));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "keep the desk by the window" });
  });

  test("Replace context is the action when context was already typed, and only a click applies it", async () => {
    const user = userEvent.setup();
    transcribeResolves("spoken replacement");
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), pngFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "typed original");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());

    const applyButton = await screen.findByRole("button", { name: "Replace context" });
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("typed original");

    await user.click(applyButton);
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "spoken replacement" });
  });

  test("a pending transcript the user never applied is NOT submitted", async () => {
    const user = userEvent.setup();
    transcribeResolves("never applied");
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), pngFile());
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await screen.findByLabelText(/transcript to review/i);
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: null });
  });

  test("submission is disabled while transcription is running, and enabled again after", async () => {
    const user = userEvent.setup();
    let settle;
    client.transcribeAudio.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/room photo/i), pngFile());
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

  test("an unavailable transcription service points back at typed context and changes nothing", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockRejectedValue(
      new Error('POST /transcribe failed: 503 {"detail":"transcription is unavailable"}'),
    );
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/room photo/i), pngFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "keep the desk by the window");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());

    expect(await screen.findByText(VOICE_MESSAGES.unavailable)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "keep the desk by the window" });
  });

  test("the image-type check is unaffected by the voice input", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/room photo/i), {
      target: { files: [new File(["fake"], "room.webp", { type: "image/webp" })] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/PNG or JPEG/i);
    expect(screen.getByLabelText(/audio file/i)).toBeEnabled();
  });

  test("the voice controls are disabled while the room upload itself is running", () => {
    render(<ReorganiseUploadForm phase="analysing" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/audio file/i)).toBeDisabled();
  });
});
