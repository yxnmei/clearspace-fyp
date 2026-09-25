import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeclutterPage from "./DeclutterPage";
import BothPage from "./BothPage";
import * as client from "../api/client";

// End-to-end through the REAL useDeclutterFlow / useBothFlow, contracts and
// components; only the network boundary is mocked. Covers, for BOTH the
// Declutter and the Both workflow:
//   - one user-facing name per item_id (a listing rename shows on Decide
//     items without any /override call or decision change);
//   - listing drafts reconciled by item_id across a re-confirmation
//     (existing drafts and edits kept, a newly confirmed Sell item drafted
//     on its own with one single-item request, no new batch);
//   - Start over clearing every listing draft and name.

vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
  generateConfirmedReorganisation: vi.fn(),
  getImageGenHealth: vi.fn(),
  generateListings: vi.fn(),
  regenerateListing: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => "blob:mock-room");
  global.URL.revokeObjectURL = vi.fn();
  client.getImageGenHealth.mockResolvedValue({ available: true });
});

const HASH = "b".repeat(64);
const RUN = "run-r";

// Two lamps (duplicate labels, distinct item_ids) and a chair.
const SPECS = [
  { id: "item_001", label: "lamp", ai: "sell" },
  { id: "item_002", label: "chair", ai: "keep" },
  { id: "item_003", label: "lamp", ai: "sell" },
];

function makeFile() {
  return new File(["fake"], "room.png", { type: "image/png" });
}

function uploadResponse(path) {
  return {
    run_id: RUN,
    path,
    input_image_sha256: HASH,
    analysis: {
      run_id: RUN,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items: SPECS.map((s, i) => ({
        item_id: s.id,
        source_detection_index: i,
        raw_phrase: s.label,
        clean_label: s.label,
        box: { x1: 0.1 * (i + 1), y1: 0.1, x2: 0.1 * (i + 1) + 0.05, y2: 0.2 },
        confidence: 0.8,
        position: "upper-left",
        relative_size: "small",
        item_role: "actionable",
        item_role_source: "default",
        corrected_label: null,
        label_source: "detector",
        effective_label: s.label,
      })),
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: RUN,
      expected_item_ids: SPECS.map((s) => s.id),
      ai_decisions: SPECS.map((s) => ({ item_id: s.id, decision: s.ai, reason: `reason ${s.id}` })),
      unresolved_item_ids: [],
      item_validity: Object.fromEntries(SPECS.map((s) => [s.id, "raw_valid"])),
      mapping_warnings: [],
      semantic_errors: [],
      recovery_failures: [],
      provenance_warnings: [],
      is_complete: true,
      is_strictly_valid: true,
      model_name: "phi4-mini",
      prompt_version: "v2",
      stage_timings: [],
    },
  };
}

function confirmResponse(decisionById = {}) {
  const cds = SPECS.map((s) => {
    const confirmed = decisionById[s.id] ?? s.ai;
    return {
      item_id: s.id,
      ai_decision: s.ai,
      confirmed_decision: confirmed,
      ai_reason: `reason ${s.id}`,
      user_reason: null,
      excluded: false,
      decision_changed: confirmed !== s.ai,
    };
  });
  return {
    run_id: RUN,
    confirmed_decisions: cds,
    confirmed_keep_ids: cds.filter((c) => c.confirmed_decision === "keep").map((c) => c.item_id),
    decision_changed_count: cds.filter((c) => c.decision_changed).length,
    excluded_count: 0,
  };
}

function draft(itemId, label, title) {
  return {
    item_id: itemId,
    effective_label: label,
    status: "generated",
    title,
    description: `A used ${label} in ordinary condition, ready for a new home.`,
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
  };
}

const PROVENANCE = { model_name: "phi4-mini", prompt_version: "v2", max_attempts: 3 };

function batch(confirmation, drafts) {
  return { run_id: RUN, confirmation, drafts, ...PROVENANCE };
}

function single(confirmation, d) {
  return { run_id: RUN, confirmation, draft: d, ...PROVENANCE };
}

async function toResults(user, path) {
  client.uploadImage.mockResolvedValueOnce(uploadResponse(path));
  await user.upload(screen.getByLabelText(/space photo/i), makeFile());
  await user.click(screen.getByRole("button", { name: /^analyse space$/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /continue to decide items/i })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /continue to decide items/i }));
  await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
  client.confirmDecisions.mockResolvedValueOnce(confirmResponse());
  await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /continue to results/i }));
}

async function generateFirstDrafts(user) {
  client.generateListings.mockResolvedValueOnce(
    batch(confirmResponse(), [draft("item_001", "lamp", "Lamp one"), draft("item_003", "lamp", "Lamp three")])
  );
  await user.click(screen.getByRole("button", { name: /generate listing drafts/i }));
  await waitFor(() => expect(screen.getByDisplayValue("Lamp three")).toBeInTheDocument());
}

const card = (itemId) => document.querySelector(`article[data-item-id="${itemId}"]`);

describe.each([
  ["Declutter", DeclutterPage, "declutter"],
  ["Both", BothPage, "both"],
])("%s: listing names and drafts across screens", (_name, Page, path) => {
  test("a listing rename shows on Decide items for that item_id only, with no override call or decision change", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await toResults(user, path);
    await generateFirstDrafts(user);

    const nameInput = within(card("item_003")).getByLabelText("Listing name for lamp");
    await user.clear(nameInput);
    await user.paste("Brass reading lamp"); // one input event: typing key by key re-renders the whole page per key
    expect(within(card("item_003")).getByRole("heading", { level: 3, name: "Brass reading lamp" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go to Decide items" }));
    // The renamed lamp and the other lamp stay distinct, keyed by item_id:
    // role queries only see the visible Decide items view.
    expect(screen.getByRole("group", { name: "Your decision for Brass reading lamp" })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Your decision for lamp" })).toHaveLength(1);
    expect(screen.getByText(/your listing name\. detected as lamp\./i)).toBeInTheDocument();
    expect(client.overrideItem).not.toHaveBeenCalled();
    // Nothing about the decisions changed, so the confirmation still stands.
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument();
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1);
  });

  test("marking another item Sell keeps existing drafts and edits, and drafts only the new item", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await toResults(user, path);
    await generateFirstDrafts(user);

    const title = within(card("item_001")).getByLabelText(/listing title for lamp/i);
    await user.clear(title);
    await user.paste("My edited lamp");

    await user.click(screen.getByRole("button", { name: "Go to Decide items" }));
    const chairGroup = screen.getByRole("group", { name: "Your decision for chair" });
    await user.click(within(chairGroup).getByRole("radio", { name: "Sell" }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    client.confirmDecisions.mockResolvedValueOnce(confirmResponse({ item_002: "sell" }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    // Existing drafts are back at once, edit intact, with no new request.
    expect(within(card("item_001")).getByLabelText(/listing title for lamp/i)).toHaveValue("My edited lamp");
    expect(card("item_003")).not.toBeNull();
    const newItems = screen.getByRole("region", { name: /new items to list/i });
    expect(within(newItems).getByText("chair")).toBeInTheDocument();
    expect(client.generateListings).toHaveBeenCalledTimes(1);

    client.regenerateListing.mockResolvedValueOnce(single(confirmResponse({ item_002: "sell" }), draft("item_002", "chair", "Oak chair")));
    await user.click(within(newItems).getByRole("button", { name: /write a draft for this item/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Oak chair")).toBeInTheDocument());

    expect(client.regenerateListing).toHaveBeenCalledTimes(1);
    expect(client.regenerateListing.mock.calls[0][0].itemId).toBe("item_002");
    expect(client.generateListings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: /new items to list/i })).not.toBeInTheDocument();
    expect(within(card("item_001")).getByLabelText(/listing title for lamp/i)).toHaveValue("My edited lamp");
  });

  test("an item moved off Sell disappears from the listings, and Start over clears every draft and name", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await toResults(user, path);
    await generateFirstDrafts(user);
    const nameInput = within(card("item_001")).getByLabelText("Listing name for lamp");
    await user.clear(nameInput);
    await user.paste("Desk lamp");

    await user.click(screen.getByRole("button", { name: "Go to Decide items" }));
    // item_001 is now "Desk lamp", so the only group still named "lamp" is item_003.
    const otherLamp = screen.getByRole("group", { name: "Your decision for lamp" });
    await user.click(within(otherLamp).getByRole("radio", { name: "Keep" }));
    await user.click(screen.getByRole("button", { name: /continue to confirm/i }));
    client.confirmDecisions.mockResolvedValueOnce(confirmResponse({ item_003: "keep" }));
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /choices confirmed/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continue to results/i }));

    expect(card("item_001")).not.toBeNull();
    expect(card("item_003")).toBeNull();
    expect(screen.queryByRole("region", { name: /new items to list/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start over/i }));
    expect(screen.queryByText("Desk lamp")).not.toBeInTheDocument();
    expect(document.querySelectorAll("article[data-item-id]")).toHaveLength(0);
  });
});
