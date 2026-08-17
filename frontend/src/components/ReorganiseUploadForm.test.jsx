import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import ReorganiseUploadForm from "./ReorganiseUploadForm";

beforeEach(() => {
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  global.URL.revokeObjectURL = vi.fn();
});

function pngFile(name = "room.png") {
  return new File(["fake"], name, { type: "image/png" });
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
