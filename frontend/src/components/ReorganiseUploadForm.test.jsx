import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import ReorganiseUploadForm from "./ReorganiseUploadForm";
import { VOICE_MESSAGES } from "../hooks/useVoiceContext";
import * as client from "../api/client";

// Mocked only because the voice input this form now mounts calls it,
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

function apiError(status, detail = null) {
  return Object.assign(new Error("The service could not complete the request. Please try again."), {
    name: "ApiError",
    status,
    detail,
  });
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
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeDisabled();
  });

  test("choosing a PNG file enables submit and shows a preview", async () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/space photo/i);
    await userEvent.upload(input, pngFile());
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeEnabled();
    expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument();
  });

  test("choosing an unsupported file type shows an error and keeps submit disabled", () => {
    // Uses fireEvent directly, not userEvent.upload: user-event's own
    // upload() emulates the real browser file PICKER, which already
    // filters by the input's accept attribute before this component's
    // code ever runs, that's a real browser behaviour, not this
    // component's own validation. fireEvent bypasses that picker
    // emulation so this test exercises OUR defense-in-depth check
    // (relevant for drag-and-drop or a browser that doesn't enforce
    // accept), not user-event's.
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/space photo/i);
    const webp = new File(["fake"], "room.webp", { type: "image/webp" });
    fireEvent.change(input, { target: { files: [webp] } });

    expect(screen.getByRole("alert")).toHaveTextContent(/PNG or JPEG/i);
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeDisabled();
  });

  test("submitting calls onSubmit with the file and trimmed context", async () => {
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);
    const file = pngFile();
    await userEvent.upload(screen.getByLabelText(/space photo/i), file);
    await userEvent.type(screen.getByLabelText(/context for the ai/i), "  keep the desk by the window  ");
    await userEvent.click(screen.getByRole("button", { name: /analyse space/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "keep the desk by the window" });
  });

  test("blank context is submitted as null", async () => {
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);
    await userEvent.upload(screen.getByLabelText(/space photo/i), pngFile());
    await userEvent.click(screen.getByRole("button", { name: /analyse space/i }));
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: null });
  });

  test("shows a status message while analysing and disables the form", () => {
    render(<ReorganiseUploadForm phase="analysing" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/analysing your space/i);
    expect(screen.getByLabelText(/space photo/i)).toBeDisabled();
  });

  test("shows an upload error as an alert, allowing retry", () => {
    render(<ReorganiseUploadForm phase="upload" error="Reorganise upload failed" onSubmit={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/reorganise upload failed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/try again/i);
  });
});

describe("ReorganiseUploadForm, voice context", () => {
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

    await user.upload(screen.getByLabelText(/space photo/i), file);
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await user.click(await screen.findByRole("button", { name: "Use as context" }));
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file, context: "keep the desk by the window" });
  });

  test("Replace context is the action when context was already typed, and only a click applies it", async () => {
    const user = userEvent.setup();
    transcribeResolves("spoken replacement");
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), pngFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "typed original");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());

    const applyButton = await screen.findByRole("button", { name: "Replace context" });
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("typed original");

    await user.click(applyButton);
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "spoken replacement" });
  });

  test("a pending transcript the user never applied is NOT submitted", async () => {
    const user = userEvent.setup();
    transcribeResolves("never applied");
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), pngFile());
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());
    await screen.findByLabelText(/transcript to review/i);
    await user.click(screen.getByRole("button", { name: /analyse space/i }));

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

    await user.upload(screen.getByLabelText(/space photo/i), pngFile());
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

  test("an unavailable transcription service points back at typed context and changes nothing", async () => {
    const user = userEvent.setup();
    client.transcribeAudio.mockRejectedValue(apiError(503, "transcription is unavailable"));
    const onSubmit = vi.fn();
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={onSubmit} />);

    await user.upload(screen.getByLabelText(/space photo/i), pngFile());
    await user.type(screen.getByLabelText(/context for the ai/i), "keep the desk by the window");
    await user.upload(screen.getByLabelText(/audio file/i), audioFile());

    expect(await screen.findByText(VOICE_MESSAGES.unavailable)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /analyse space/i }));
    expect(onSubmit).toHaveBeenCalledWith({ file: expect.any(File), context: "keep the desk by the window" });
  });

  test("the image-type check is unaffected by the voice input", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/space photo/i), {
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

describe("ReorganiseUploadForm, space photo presentation (redesign)", () => {
  test("uses inclusive space wording in the upload heading and guidance", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 2, name: "Upload a photo of your space" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload one clear photo with most items in frame. Context is optional."
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Space photo")).toBeInTheDocument();
    expect(screen.getByText("PNG or JPEG of one indoor space, photographed so most items are visible.")).toBeInTheDocument();
  });

  test("the file input is restricted to PNG and JPEG", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/space photo/i)).toHaveAttribute("accept", "image/png,image/jpeg");
  });

  test("the selected filename is shown from File.name, no path, no fake path", async () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);

    await userEvent.upload(screen.getByLabelText(/space photo/i), pngFile("living_room.png"));

    const shown = screen.getByText("living_room.png");
    expect(shown.textContent).toBe("living_room.png");
    expect(shown.textContent).not.toMatch(/[\\/]/);
    expect(shown.textContent).not.toMatch(/fakepath|Users|C:\\/i);
  });

  test("an unsupported type leaves the field empty, shows a field alert, and never shows that filename", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/space photo/i), {
      target: { files: [new File(["fake"], "clip.webp", { type: "image/webp" })] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/PNG or JPEG/i);
    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    expect(screen.queryByText("clip.webp")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /analyse space/i })).toBeDisabled();
  });

  test("replacing the photo swaps the filename and revokes exactly the previous object URL", async () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);

    await userEvent.upload(screen.getByLabelText(/space photo/i), pngFile("first.png"));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await userEvent.upload(screen.getByLabelText(/space photo/i), pngFile("second.png"));

    expect(screen.getByText("second.png")).toBeInTheDocument();
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-preview");
  });

  test("the photo and context areas sit side by side on wide screens", () => {
    const { container } = render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    expect(container.querySelector(".grid").className).toMatch(/lg:grid-cols-2/);
  });

  test("the real file input stays focusable and disables with the rest of the form", () => {
    const { rerender } = render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/space photo/i);
    input.focus();
    expect(input).toHaveFocus();

    rerender(<ReorganiseUploadForm phase="analysing" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/space photo/i)).toBeDisabled();
  });

  test("the submit button is a real submit control, not a plain button", () => {
    render(<ReorganiseUploadForm phase="upload" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /analyse space/i })).toHaveAttribute("type", "submit");
  });
});

describe("ReorganiseUploadForm, shared Upload photo composition (redesign phase)", () => {
  const button = () => screen.getByRole("button", { name: /analys/i });
  const classes = (el) => el.className.split(/\s+/).filter(Boolean);
  const png = (name = "room.png") => new File(["png"], name, { type: "image/png" });

  test("the form is named by the exact shared heading and carries the exact supporting copy, with no step number", () => {
    render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    const form = screen.getByRole("form", { name: "Upload a photo of your space" });
    expect(within(form).getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(
      within(form).getByText(
        "Upload one clear photo with most items in frame. Context is optional."
      )
    ).toBeInTheDocument();
    expect(form.textContent).not.toMatch(/^\s*1\./);
    expect(form.textContent).not.toMatch(/\broom\b|drag|drop/i);
  });

  test("empty state: calm placeholder, Choose photo, PNG/JPEG help text, no filename slot, no preview", () => {
    render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    expect(screen.getByText(/choose photo/i)).toBeInTheDocument();
    expect(screen.getByText("PNG or JPEG of one indoor space, photographed so most items are visible.")).toBeInTheDocument();
    expect(screen.queryByText("No photo selected")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("selected state: emphasised preview with alt text, Replace photo and a truncating filename", async () => {
    const user = userEvent.setup();
    render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), png("a-really-long-name-for-a-study-photo-taken-on-my-phone.png"));
    const img = screen.getByRole("img", { name: "Preview of the space photo you selected to reorganise" });
    expect(img.parentElement.className).toMatch(/border-primary/);
    expect(screen.getByText(/replace photo/i)).toBeInTheDocument();
    expect(screen.getByText("a-really-long-name-for-a-study-photo-taken-on-my-phone.png").className).toMatch(/truncate/);
  });

  test("the primary action sits at the right edge at every width, at natural width, with a 44px target on phones", () => {
    render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    const cls = classes(button());
    for (const c of ["min-h-11", "sm:min-h-0", "self-end"]) expect(cls).toContain(c);
    // not stretched on phones, and never left-aligned from sm
    expect(cls).not.toContain("w-full");
    expect(cls.some((c) => /self-start$/.test(c))).toBe(false);
    expect(button().parentElement.className).toMatch(/\bflex-col\b/);
  });

  test("analysing: 'Analysing…' label, aria-busy, disabled, and a jargon-free status", () => {
    render(<ReorganiseUploadForm phase="analysing" error={null} onSubmit={vi.fn()} />);
    expect(button()).toHaveTextContent("Analysing…");
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute("aria-busy", "true");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Analysing your space. This may take up to two minutes.");
    expect(status.textContent).not.toMatch(/classification|detection|reasoning|computer|\broom\b/i);
  });

  test("the PNG/JPEG rule is unchanged: a rejected type clears the field, shows a wired alert and keeps submit disabled", async () => {
    const user = userEvent.setup();
    render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), png("good.png"));
    expect(button()).toBeEnabled();

    const webp = new File(["x"], "bad.webp", { type: "image/webp" });
    // fireEvent bypasses user-event's picker emulation so OUR type check runs (see the earlier test)
    fireEvent.change(screen.getByLabelText(/space photo/i), { target: { files: [webp] } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent('"image/webp" is not supported. Please choose a PNG or JPEG photo.');
    expect(screen.getByLabelText(/space photo/i).getAttribute("aria-describedby")).toContain(alert.id);
    expect(button()).toBeDisabled();
    expect(screen.queryByText("bad.webp")).not.toBeInTheDocument();
    expect(screen.queryByText("good.png")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/no photo selected yet/i)).toBeInTheDocument();
    expect(screen.getByText(/choose photo/i)).toBeInTheDocument();
  });

  test("a request failure is an inline alert associated with the action, and the photo and context survive", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), png("keep-me.png"));
    await user.type(screen.getByLabelText(/context for the ai/i), "still here");

    rerender(<ReorganiseUploadForm phase="selecting" error="Reorganise upload failed." onSubmit={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Reorganise upload failed. You can try again. Your selected photo and context are still here.");
    expect(button()).toHaveAttribute("aria-describedby", alert.id);
    expect(button()).toBeEnabled();
    expect(screen.getByText("keep-me.png")).toBeInTheDocument();
    expect(screen.getByLabelText(/context for the ai/i)).toHaveValue("still here");
  });

  test("the context textarea is labelled and described by its optional hint", () => {
    render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Context for the AI (optional)")).toHaveAccessibleDescription(
      /anything that helps the ai understand your space/i
    );
  });

  test("unmounting with a selected photo revokes its object URL exactly once", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    await user.upload(screen.getByLabelText(/space photo/i), png());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  test("layout: photo column first, optional context second, one column below lg", () => {
    const { container } = render(<ReorganiseUploadForm phase="idle" error={null} onSubmit={vi.fn()} />);
    const grid = container.querySelector(".grid");
    expect(grid.className).toMatch(/\blg:grid-cols-2\b/);
    expect(grid.className.split(/\s+/)).not.toContain("grid-cols-2");
    expect(grid.children[0]).toContainElement(screen.getByLabelText(/space photo/i));
    expect(grid.children[1]).toContainElement(screen.getByLabelText(/context for the ai/i));
    expect(container.innerHTML).not.toMatch(/overflow-x-auto|w-screen/);
  });
});

describe("ReorganiseUploadForm footer alignment (Direct Reorganise)", () => {
  test("the busy state keeps the same alignment and stays disabled", () => {
    render(<ReorganiseUploadForm phase="analysing" error={null} onSubmit={vi.fn()} />);
    const button = screen.getByRole("button", { name: /analysing/i });
    expect(button).toBeDisabled();
    expect(button.className.split(/\s+/)).toContain("self-end");
  });
});
