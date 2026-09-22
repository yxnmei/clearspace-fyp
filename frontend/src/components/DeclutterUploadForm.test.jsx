import { act, render, screen, waitFor, within } from "@testing-library/react";
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

    expect(screen.getByRole("heading", { level: 2, name: "Upload a photo of your space" })).toBeInTheDocument();
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
    expect(img.className).toMatch(/max-h-80/);
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

describe("DeclutterUploadForm, shared Upload photo composition (redesign phase)", () => {
  const button = () => screen.getByRole("button", { name: /analys/i });
  const classes = (el) => el.className.split(/\s+/).filter(Boolean);

  test("the form is named by the exact shared heading and carries the exact supporting copy, with no step number", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    const form = screen.getByRole("form", { name: "Upload a photo of your space" });
    expect(within(form).getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(within(form).getByRole("heading", { level: 2 })).toHaveTextContent(/^Upload a photo of your space$/);
    expect(
      within(form).getByText(
        "Upload one clear photo of your space, with most items in frame. You can also provide optional context to help the AI better understand your space."
      )
    ).toBeInTheDocument();
    expect(form.textContent).not.toMatch(/^\s*1\./);
    expect(form.textContent).not.toMatch(/\broom\b|drag|drop/i);
  });

  test("empty state: calm placeholder, Choose photo, format help text, no filename slot, no preview", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    expect(screen.getByText(/choose photo/i)).toBeInTheDocument();
    expect(screen.getByText("JPG or PNG of one indoor space, photographed so most items are visible.")).toBeInTheDocument();
    expect(screen.queryByText("No photo selected")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/space photo/i).getAttribute("aria-describedby")).toContain(
      screen.getByText(/photographed so most items are visible/i).id
    );
  });

  test("selected state: emphasised preview with alt text, Replace photo, the filename in a truncating slot", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("a-really-long-name-for-a-living-space-photo-taken-on-my-phone.jpg"));
    const img = screen.getByRole("img", { name: "Preview of the space photo you selected to declutter" });
    expect(img.parentElement.className).toMatch(/border-primary/);
    expect(screen.getByText(/replace photo/i)).toBeInTheDocument();
    expect(screen.queryByText(/choose photo/i)).not.toBeInTheDocument();
    const name = screen.getByText("a-really-long-name-for-a-living-space-photo-taken-on-my-phone.jpg");
    expect(name.className).toMatch(/truncate/);
    expect(screen.queryByText(/no photo selected yet/i)).not.toBeInTheDocument();
  });

  test("the primary action is full width with a 44px target on phones and natural width from sm", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    const cls = classes(button());
    for (const c of ["min-h-11", "w-full", "sm:min-h-0", "sm:w-auto"]) expect(cls).toContain(c);
  });

  test("disabled without a file, enabled with a valid file, and it stays the only primary control", async () => {
    const user = userEvent.setup();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    expect(button()).toBeDisabled();
    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent("Analyse space");
    expect(screen.getAllByRole("button", { name: /analyse space/i })).toHaveLength(1);
  });

  test("uploading: 'Analysing…' label, aria-busy, disabled, and a jargon-free status", () => {
    render(<DeclutterUploadForm status="uploading" error={null} onSubmit={vi.fn()} />);
    expect(button()).toHaveTextContent("Analysing…");
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute("aria-busy", "true");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Analysing your space. This may take up to two minutes.");
    expect(status.textContent).not.toMatch(/classification|detection|reasoning|computer|\broom\b/i);
    expect(screen.getByLabelText(/space photo/i)).toBeDisabled();
    expect(screen.getByLabelText(/context for the ai/i)).toBeDisabled();
  });

  test("context is trimmed, and blank context becomes null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={onSubmit} />);
    const file = makeFile();
    await user.upload(screen.getByLabelText(/space photo/i), file);
    await user.type(screen.getByLabelText(/context for the ai/i), "   keep it minimal   ");
    await user.click(button());
    expect(onSubmit).toHaveBeenLastCalledWith({ file, context: "keep it minimal" });

    await user.clear(screen.getByLabelText(/context for the ai/i));
    await user.type(screen.getByLabelText(/context for the ai/i), "   ");
    await user.click(button());
    expect(onSubmit).toHaveBeenLastCalledWith({ file, context: null });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  test("the context textarea is labelled and described by its optional hint", () => {
    render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    const textarea = screen.getByLabelText("Context for the AI (optional)");
    expect(textarea).toHaveAccessibleDescription(/anything that helps the ai understand your space/i);
  });

  test("a request failure is an inline alert associated with the action, and the photo and context survive", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), makeFile("keep-me.jpg"));
    await user.type(screen.getByLabelText(/context for the ai/i), "still here");

    rerender(<DeclutterUploadForm status="error" error="Declutter upload failed." onSubmit={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Declutter upload failed. You can try again. Your selected photo and context are still here.");
    expect(button()).toHaveAttribute("aria-describedby", alert.id);
    expect(button()).toBeEnabled();
    expect(screen.getByText("keep-me.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("still here");
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  test("unmounting with a selected photo revokes its object URL exactly once", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), makeFile());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-preview-url");
  });

  test("layout: photo column first, optional context second, one column below lg", () => {
    const { container } = render(<DeclutterUploadForm status="idle" error={null} onSubmit={vi.fn()} />);
    const grid = container.querySelector(".grid");
    expect(grid.className).toMatch(/\blg:grid-cols-2\b/);
    expect(grid.className.split(/\s+/)).not.toContain("grid-cols-2");
    expect(grid.children[0]).toContainElement(screen.getByLabelText(/space photo/i));
    expect(grid.children[1]).toContainElement(screen.getByLabelText(/context for the ai/i));
    expect(container.innerHTML).not.toMatch(/overflow-x-auto|w-screen/);
  });
});
