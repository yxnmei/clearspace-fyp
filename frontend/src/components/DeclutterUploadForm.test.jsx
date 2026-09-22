import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeclutterUploadForm from "./DeclutterUploadForm";
import { VOICE_MESSAGES } from "../hooks/useVoiceContext";
import * as client from "../api/client";

// The form itself still never talks to the API, this mock exists only
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
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeDisabled();
  });

  test("selecting an image enables submission", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());

    expect(screen.getByRole("button", { name: /analyse space/i })).toBeEnabled();
  });

  test("typed context is passed to submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const file = makeFile();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), file);
    await user.type(screen.getByLabelText(/context for the ai/i), "downsizing before a move");
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "downsizing before a move" });
  });

  test("uploading shows truthful progress copy and disables submission", () => {
    render(<DeclutterUploadForm status="uploading" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(/up to two minutes/i);
    expect(screen.getByRole("button", { name: /analysing/i })).toBeDisabled();
    expect(screen.getByLabelText(/space photo/i)).toBeDisabled();
  });

  test("upload failure displays an alert while retaining the form", async () => {
    const user = userEvent.setup();
    const file = makeFile();
    render(<DeclutterUploadForm status="error" error="Declutter upload failed" onSubmit={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/declutter upload failed/i);
    // The form itself is still present and usable, nothing was discarded.
    await user.upload(screen.getByLabelText(/space photo/i), file);
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeEnabled();
  });

  test("inputs have accessible labels", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/space photo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toBeInTheDocument();
  });

  test("the room preview has alt text once a file is selected", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());

    expect(screen.getByRole("img")).toHaveAccessibleName(/space photo/i);
  });
});

describe("DeclutterUploadForm, voice context", () => {
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

    await user.upload(screen.getByLabelText(/space photo/i), file);
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await user.click(await screen.findByRole("button", { name: "Use as context" }));
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "I am downsizing before a move" });
  });

  test("an EDITED transcript is what reaches onSubmit", async () => {
    const user = userEvent.setup();
    transcribeResolves("downsizing");
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    const transcriptBox = await screen.findByLabelText(/transcript to review/i);
    await user.clear(transcriptBox);
    await user.type(transcriptBox, "downsizing and being decisive");
    await user.click(screen.getByRole("button", { name: "Use as context" }));
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "downsizing and being decisive" });
  });

  test("a pending transcript the user never applied is NOT submitted", async () => {
    const user = userEvent.setup();
    transcribeResolves("never applied");
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await screen.findByLabelText(/transcript to review/i);
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

    // Transcription has finished, so submitting is allowed, but the
    // unapplied transcript contributes nothing.
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: null });
  });

  test("typed context survives an unapplied transcript arriving next to it", async () => {
    const user = userEvent.setup();
    transcribeResolves("spoken instead");
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "typed original");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await screen.findByLabelText(/transcript to review/i);
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

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

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeEnabled();

    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await waitFor(() => expect(screen.getByRole("button", { name: /analyse space/i })).toBeDisabled());

    await act(async () => {
      settle({
        transcript: "done now",
        model_name: "whisper-base",
        transcription_ms: 10,
        audio_duration_s: 1,
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /analyse space/i })).toBeEnabled());
  });

  test("a voice failure leaves the typed context and the form intact", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockRejectedValue(new Error("Failed to fetch"));
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "typed original");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());

    expect(await screen.findByText(VOICE_MESSAGES.failed)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /analyse space/i }));
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "typed original" });
  });

  test("the voice controls are disabled while the room upload itself is running", () => {
    render(<DeclutterUploadForm status="uploading" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/audio file/i)).toBeDisabled();
  });
});

describe("DeclutterUploadForm, space photo presentation (redesign)", () => {
  test("uses inclusive space wording in the upload heading and guidance", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "1. Upload a photo of your space" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload one clear photo of your space, with most items in frame. You can also provide optional context to help the AI better understand your space."
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Space photo")).toBeInTheDocument();
    expect(screen.getByText("JPG or PNG of one indoor space, photographed so most items are visible.")).toBeInTheDocument();
  });

  test("the file input still accepts any image type", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/space photo/i)).toHaveAttribute("accept", "image/*");
  });

  test("the selected filename is shown from File.name, no path, no fake path", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile("living_room.jpg"));

    const shown = screen.getByText("living_room.jpg");
    expect(shown.textContent).toBe("living_room.jpg");
    expect(shown.textContent).not.toMatch(/[\\/]/);
    expect(shown.textContent).not.toMatch(/fakepath|Users|C:\\/i);
  });

  test("replacing the photo swaps the filename and revokes exactly the previous object URL", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/space photo/i), makeFile("first.jpg"));
    expect(screen.getByText("first.jpg")).toBeInTheDocument();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await user.upload(screen.getByLabelText(/space photo/i), makeFile("second.jpg"));

    expect(screen.getByText("second.jpg")).toBeInTheDocument();
    expect(screen.queryByText("first.jpg")).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-preview-url");
  });

  test("a bounded preview with alt text replaces the empty state after selection", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    await user.upload(screen.getByLabelText(/space photo/i), makeFile());

    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName(/preview of the space photo you selected to declutter/i);
    expect(img.className).toMatch(/max-h-64/);
    expect(screen.queryByText(/no photo selected yet/i)).not.toBeInTheDocument();
  });

  test("the photo and context areas sit side by side on wide screens", () => {
    const { container } = render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(container.querySelector(".grid").className).toMatch(/lg:grid-cols-2/);
  });

  test("the real file input stays focusable and disables with the rest of the form", () => {
    const { rerender } = render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/space photo/i);
    input.focus();
    expect(input).toHaveFocus();

    rerender(<DeclutterUploadForm status="uploading" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/space photo/i)).toBeDisabled();
  });

  test("the submit button is a real submit control, not a plain button", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /analyse space/i })).toHaveAttribute("type", "submit");
  });
});
