import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";

vi.mock("./api/client", () => ({
  uploadImage: vi.fn(),
  generateReorganisation: vi.fn(),
  generateConfirmedReorganisation: vi.fn(),
  getImageGenHealth: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  global.URL.revokeObjectURL = vi.fn();
  client.getImageGenHealth.mockResolvedValue({ available: true });
});

describe("App — path selection", () => {
  test("starts at path selection with no workflow mounted", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /^declutter/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("choosing Declutter mounts the existing Declutter workflow", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^declutter/i }));
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();
    expect(screen.getByText(/keep \/ sell \/ donate \/ discard/i)).toBeInTheDocument();
  });

  test("choosing Reorganise mounts the Reorganise workflow", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^reorganise/i }));
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalled());
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();
    expect(screen.getByText(/png or jpeg of one room/i)).toBeInTheDocument();
  });

  test("choosing Both mounts the Both workflow (R6)", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^both/i }));
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalled());
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();
    expect(client.uploadImage).not.toHaveBeenCalled(); // mounting alone triggers no upload
  });

  test("Back to workflow selection from Both returns to PathSelector, unmounting the workflow", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^both/i }));
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /back to workflow selection/i }));

    expect(screen.getByRole("button", { name: /^declutter/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("Back to workflow selection from Reorganise returns to PathSelector, unmounting the workflow", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^reorganise/i }));
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /back to workflow selection/i }));

    expect(screen.getByRole("button", { name: /^declutter/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("switching away from Reorganise after picking a file revokes its object URL (unmount cleanup)", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^reorganise/i }));
    const file = new File(["fake"], "room.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText(/room photo/i), file);

    await userEvent.click(screen.getByRole("button", { name: /back to workflow selection/i }));

    // The picked-file preview URL (owned by ReorganiseUploadForm's own
    // local state) is revoked on unmount via its existing cleanup effect.
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  test("Declutter back button returns to path selection too", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^declutter/i }));
    await userEvent.click(screen.getByRole("button", { name: /back to workflow selection/i }));
    expect(screen.getByRole("button", { name: /^reorganise/i })).toBeInTheDocument();
  });
});
