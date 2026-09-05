import { render, screen, waitFor, within } from "@testing-library/react";
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
  generateListings: vi.fn(),
  regenerateListing: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  global.URL.revokeObjectURL = vi.fn();
  client.getImageGenHealth.mockResolvedValue({ available: true });
});

// Select a workflow card then press Continue, the app's select-then-continue
// interaction. App mounts the chosen workflow only after Continue.
async function chooseWorkflow(user, name) {
  await user.click(screen.getByRole("radio", { name }));
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

describe("App, path selection", () => {
  test("starts at path selection with no workflow mounted", () => {
    render(<App />);
    expect(screen.getByRole("radio", { name: /declutter/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("choosing Declutter mounts the existing Declutter workflow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /declutter/i);
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();
    expect(screen.getByText(/keep \/ sell \/ donate \/ discard/i)).toBeInTheDocument();
  });

  test("choosing Reorganise mounts the Reorganise workflow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /reorganise/i);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalled());
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();
    expect(screen.getByText(/png or jpeg of one room/i)).toBeInTheDocument();
  });

  test("choosing Both mounts the Both workflow (R6)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /^both$/i);
    await waitFor(() => expect(client.getImageGenHealth).toHaveBeenCalled());
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();
    expect(client.uploadImage).not.toHaveBeenCalled(); // mounting alone triggers no upload
  });

  test("Continue is inert until a workflow is selected", async () => {
    const user = userEvent.setup();
    render(<App />);
    const continueButton = screen.getByRole("button", { name: /continue/i });
    await user.click(continueButton); // disabled, nothing should happen
    expect(screen.queryByText(/1\. upload a room photo/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /declutter/i }));
    expect(continueButton).toBeEnabled();
  });

  test("the workflow selector renders no progress stepper", () => {
    render(<App />);
    expect(screen.queryByRole("navigation", { name: /workflow progress/i })).not.toBeInTheDocument();
  });
});

describe("App, each workflow page shows its own progress stepper", () => {
  test.each([
    [/declutter/i, /declutter workflow progress/i, ["Upload", "Analyse", "Review", "Confirm", "Listings"]],
    [/reorganise/i, /reorganise workflow progress/i, ["Upload", "Analyse", "Review", "Generate"]],
    [/^both$/i, /both workflow progress/i, ["Upload", "Analyse", "Review", "Confirm", "Reorganise"]],
  ])("mounting %s renders its stepper with its exact step sequence", async (card, navName, steps) => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, card);

    const nav = await screen.findByRole("navigation", { name: navName });
    const labels = within(nav)
      .getAllByRole("listitem")
      .map((li) => li.textContent.replace(/\d+/g, "").trim());
    expect(labels).toEqual(steps);
  });

  test("the stepper starts on Upload for a freshly mounted workflow, with no step complete", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /declutter/i);

    const nav = screen.getByRole("navigation", { name: /declutter workflow progress/i });
    const items = within(nav).getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("aria-current", "step"); // Upload
    expect(items.filter((li) => li.getAttribute("aria-current") === "step")).toHaveLength(1);
  });

  test("switching back to the selector removes the stepper again", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /declutter/i);
    expect(screen.getByRole("navigation", { name: /workflow progress/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to workflows/i }));
    expect(screen.queryByRole("navigation", { name: /workflow progress/i })).not.toBeInTheDocument();
  });
});

describe("App, Back to workflows unmounts the active workflow", () => {
  test("from Both", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /^both$/i);
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to workflows/i }));

    expect(screen.getByRole("radio", { name: /declutter/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("from Reorganise", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /reorganise/i);
    expect(screen.getByText(/1\. upload a room photo/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to workflows/i }));

    expect(screen.getByRole("radio", { name: /declutter/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/room photo/i)).not.toBeInTheDocument();
  });

  test("from Declutter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /declutter/i);
    await user.click(screen.getByRole("button", { name: /back to workflows/i }));
    expect(screen.getByRole("radio", { name: /reorganise/i })).toBeInTheDocument();
  });

  test("switching away from Reorganise after picking a file revokes its object URL (unmount cleanup)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await chooseWorkflow(user, /reorganise/i);
    const file = new File(["fake"], "room.png", { type: "image/png" });
    await user.upload(screen.getByLabelText(/room photo/i), file);

    await user.click(screen.getByRole("button", { name: /back to workflows/i }));

    // The picked-file preview URL (owned by ReorganiseUploadForm's own
    // local state) is revoked on unmount via its existing cleanup effect.
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  test("Back to workflows is not shown on the chooser itself", () => {
    render(<App />);
    expect(screen.queryByRole("button", { name: /back to workflows/i })).not.toBeInTheDocument();
  });
});

describe("App, shell has no fake account or notification chrome", () => {
  test("no account, profile, notification or settings controls exist", () => {
    render(<App />);
    expect(screen.queryByRole("button", { name: /account|profile|sign in|log in|notification|settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /avatar/i })).not.toBeInTheDocument();
  });

  test("the ClearSpace brand is present in the shell header", () => {
    render(<App />);
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent(/clearspace/i);
  });
});
