import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeclutterUploadForm from "./DeclutterUploadForm";

function makeFile(name = "room.jpg") {
  return new File(["fake image bytes"], name, { type: "image/jpeg" });
}

beforeEach(() => {
  // jsdom does not implement object URLs.
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview-url");
  global.URL.revokeObjectURL = vi.fn();
});

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
