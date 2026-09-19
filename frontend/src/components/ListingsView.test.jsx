import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ListingsView from "./ListingsView";

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------

function decision(itemId, confirmedDecision, excluded = false) {
  return {
    item_id: itemId,
    ai_decision: confirmedDecision,
    ai_reason: "reason",
    confirmed_decision: confirmedDecision,
    user_reason: null,
    excluded,
    decision_changed: false,
  };
}

function makeConfirmation(decisions) {
  return {
    runId: "run_1",
    confirmedDecisions: decisions,
    confirmedKeepIds: decisions
      .filter((d) => d.confirmed_decision === "keep" && !d.excluded)
      .map((d) => d.item_id),
    decisionChangedCount: 0,
    excludedCount: decisions.filter((d) => d.excluded).length,
  };
}

function genDraft(itemId, overrides = {}) {
  const title = overrides.title ?? "A perfectly good listing title";
  const description =
    overrides.description ?? "A sufficiently long and descriptive listing description here.";
  return {
    item_id: itemId,
    effective_label: overrides.effective_label ?? "item",
    status: "generated",
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
    title,
    description,
    edited_title: overrides.edited_title ?? title,
    edited_description: overrides.edited_description ?? description,
    is_edited: overrides.is_edited ?? false,
    is_discarded: overrides.is_discarded ?? false,
  };
}

function unavailDraft(itemId, reason = "timeout", overrides = {}) {
  return {
    item_id: itemId,
    effective_label: overrides.effective_label ?? "item",
    status: "unavailable",
    unavailable_reason: reason,
    was_repaired: null,
    attempts: 1,
    title: null,
    description: null,
    edited_title: "",
    edited_description: "",
    is_edited: false,
    is_discarded: overrides.is_discarded ?? false,
  };
}

function reviewItem(itemId, overrides = {}) {
  return {
    item_id: itemId,
    clean_label: overrides.clean_label ?? "item",
    effective_label: overrides.effective_label ?? "item",
    position: overrides.position ?? "center",
    relative_size: overrides.relative_size ?? "large",
    confidence: 0.7,
    box: { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 },
  };
}

function renderView(props = {}) {
  const actions = {
    generateListingDrafts: vi.fn(),
    regenerateListingDraft: vi.fn(),
    editListingDraft: vi.fn(),
    discardListingDraft: vi.fn(),
    restoreListingDraft: vi.fn(),
  };
  const utils = render(<ListingsView {...actions} {...props} />);
  return { ...utils, ...actions };
}

// Cards never show their raw item_id; they carry it as data-item-id.
function articleFor(itemId) {
  return document.querySelector(`article[data-item-id="${itemId}"]`);
}

// ---------------------------------------------------------------------------

describe("ListingsView", () => {
  describe("state: no confirmation", () => {
    test("renders no actionable listing UI and never calls generation", () => {
      const { generateListingDrafts } = renderView({ confirmation: null });
      expect(screen.queryByRole("button", { name: /generate listing drafts/i })).not.toBeInTheDocument();
      expect(screen.getByText(/confirm your declutter decisions first/i)).toBeInTheDocument();
      expect(generateListingDrafts).not.toHaveBeenCalled();
    });
  });

  describe("state: confirmed with zero eligible Sell items", () => {
    test("shows a truthful empty state, no loading/error, no Generate button, no auto call", () => {
      const confirmation = makeConfirmation([
        decision("item_001", "keep"),
        decision("item_002", "sell", true), // Sell but excluded -> not eligible
        decision("item_003", "discard"),
      ]);
      const { generateListingDrafts } = renderView({ confirmation, listingStatus: "idle" });

      expect(screen.getByText(/did not confirm any items as sell/i)).toBeInTheDocument();
      expect(screen.getByText(/go back to decide items and change an item's decision to sell/i)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(generateListingDrafts).not.toHaveBeenCalled();
    });
  });

  describe("no automatic generation", () => {
    test.each(["idle", "generating", "error", "ready"])(
      "does not call generateListingDrafts on mount in the %s state",
      (listingStatus) => {
        const confirmation = makeConfirmation([decision("item_001", "sell")]);
        const listingDrafts = listingStatus === "ready" ? [genDraft("item_001")] : [];
        const { generateListingDrafts } = renderView({ confirmation, listingStatus, listingDrafts });
        expect(generateListingDrafts).not.toHaveBeenCalled();
      }
    );
  });

  describe("state: eligible Sell items, idle", () => {
    test("explains the drafts are editable and unpublished, and offers an explicit action", async () => {
      const user = userEvent.setup();
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const { generateListingDrafts } = renderView({ confirmation, listingStatus: "idle" });

      expect(screen.getByText(/nothing is published, listed, or sent to any marketplace/i)).toBeInTheDocument();
      const button = screen.getByRole("button", { name: /generate listing drafts/i });
      expect(generateListingDrafts).not.toHaveBeenCalled();

      await user.click(button);
      expect(generateListingDrafts).toHaveBeenCalledTimes(1);
    });
  });

  describe("state: generating", () => {
    test("shows an accessible progress status and disables duplicate generation", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      renderView({ confirmation, listingStatus: "generating" });

      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(/generating/i);
      expect(screen.getByText(/nothing is being published/i)).toBeInTheDocument();
      expect(screen.getByRole("button")).toBeDisabled();
      expect(screen.queryByRole("button", { name: /^generate listing drafts$/i })).not.toBeInTheDocument();
    });
  });

  describe("state: error", () => {
    test("shows the concise error, states decisions are unchanged, and offers retry", async () => {
      const user = userEvent.setup();
      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      const { generateListingDrafts } = renderView({
        confirmation,
        listingStatus: "error",
        listingError: "Listing draft generation failed.",
      });

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/listing draft generation failed/i);
      expect(alert).toHaveTextContent(/confirmed declutter decisions are unchanged/i);

      await user.click(screen.getByRole("button", { name: /try again/i }));
      expect(generateListingDrafts).toHaveBeenCalledTimes(1);
    });
  });

  describe("state: ready", () => {
    test("renders drafts in the hook-provided order", () => {
      const confirmation = makeConfirmation([
        decision("item_001", "sell"),
        decision("item_002", "sell"),
        decision("item_003", "sell"),
      ]);
      const listingDrafts = [genDraft("item_003"), genDraft("item_001"), genDraft("item_002")];
      renderView({ confirmation, listingStatus: "ready", listingDrafts });

      const ids = Array.from(document.querySelectorAll("article[data-item-id]")).map((el) => el.dataset.itemId);
      expect(ids).toEqual(["item_003", "item_001", "item_002"]);
      expect(screen.getAllByRole("article")).toHaveLength(3);
    });

    test("joins the thumbnail strictly by item_id even when labels are identical, and shows no location text", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const reviewItems = [
        { ...reviewItem("item_001", { effective_label: "lamp", position: "upper-left" }), box: { x1: 0.0, y1: 0.0, x2: 0.2, y2: 0.2 } },
        { ...reviewItem("item_002", { effective_label: "lamp", position: "lower-right" }), box: { x1: 0.7, y1: 0.7, x2: 0.9, y2: 0.9 } },
      ];
      const listingDrafts = [
        genDraft("item_001", { effective_label: "lamp" }),
        genDraft("item_002", { effective_label: "lamp" }),
      ];
      renderView({ confirmation, listingStatus: "ready", listingDrafts, reviewItems, imageUrl: "blob:room" });

      const thumb1 = within(articleFor("item_001")).getByTestId("item-crop-thumbnail");
      const thumb2 = within(articleFor("item_002")).getByTestId("item-crop-thumbnail");
      expect(thumb1.style.backgroundPosition).not.toBe(thumb2.style.backgroundPosition);
      expect(within(articleFor("item_001")).getByLabelText(/listing title for lamp/i)).toHaveAttribute("id", "listing-title-item_001");
      expect(within(articleFor("item_002")).getByLabelText(/listing title for lamp/i)).toHaveAttribute("id", "listing-title-item_002");
      // no raw ids or position/size metadata anywhere in the section
      expect(screen.queryByText(/upper-left|lower-right|item_00\d|item_id/i)).not.toBeInTheDocument();
    });

    test("the ready state introduces the drafts once, with the reassurance said once at section level, and hides technical metadata", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const listingDrafts = [genDraft("item_001", { effective_label: "lamp" }), genDraft("item_002", { effective_label: "chair" })];
      const { container } = renderView({ confirmation, listingStatus: "ready", listingDrafts });

      expect(screen.getByRole("heading", { name: "Marketplace listings" })).toBeInTheDocument();
      expect(screen.getByText("2 listing drafts ready")).toBeInTheDocument();
      expect(screen.getAllByText(/nothing is published/i)).toHaveLength(1);
      expect(container.textContent).not.toMatch(/item_00\d|item_id|run_1|attempts|repaired|generated|phi|prompt|sha/i);
      expect(container.querySelector("code")).toBeNull();
    });

    test("renders generated and unavailable cards, and does not filter unavailable drafts out", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const listingDrafts = [genDraft("item_001"), unavailDraft("item_002", "service_unavailable")];
      renderView({ confirmation, listingStatus: "ready", listingDrafts });

      expect(within(articleFor("item_001")).getByLabelText(/listing title for/i)).toBeInTheDocument();
      expect(within(articleFor("item_002")).getByText(/service was unavailable/i)).toBeInTheDocument();
      expect(within(articleFor("item_002")).queryByLabelText(/listing title for/i)).not.toBeInTheDocument();
      expect(screen.getAllByRole("article")).toHaveLength(2);
    });

    test("a locally discarded draft stays represented with a Restore action", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      const listingDrafts = [genDraft("item_001", { is_discarded: true })];
      renderView({ confirmation, listingStatus: "ready", listingDrafts });

      expect(screen.getByText("Discarded")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /restore draft/i })).toBeInTheDocument();
    });

    test("copy feedback is scoped to the card whose Copy button was clicked", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const listingDrafts = [genDraft("item_001"), genDraft("item_002")];
      renderView({ confirmation, listingStatus: "ready", listingDrafts, clipboardWriter });

      await user.click(within(articleFor("item_001")).getByRole("button", { name: /copy listing/i }));

      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();
      expect(screen.getAllByText(/copied to your clipboard/i)).toHaveLength(1);
      expect(within(articleFor("item_002")).queryByText(/copied to your clipboard/i)).not.toBeInTheDocument();
      expect(clipboardWriter).toHaveBeenCalledTimes(1);
    });

    test("ordinary regeneration calls regenerateListingDraft only for that card's item_id", async () => {
      const user = userEvent.setup();
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const listingDrafts = [genDraft("item_001"), genDraft("item_002")];
      const { regenerateListingDraft } = renderView({ confirmation, listingStatus: "ready", listingDrafts });

      await user.click(within(articleFor("item_002")).getByRole("button", { name: /regenerate draft/i }));

      expect(regenerateListingDraft).toHaveBeenCalledTimes(1);
      expect(regenerateListingDraft).toHaveBeenCalledWith("item_002");
    });

    test("an unavailable draft can be regenerated directly", async () => {
      const user = userEvent.setup();
      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      const listingDrafts = [unavailDraft("item_001", "generation_failed")];
      const { regenerateListingDraft } = renderView({ confirmation, listingStatus: "ready", listingDrafts });

      await user.click(screen.getByRole("button", { name: /regenerate draft/i }));

      expect(regenerateListingDraft).toHaveBeenCalledWith("item_001");
    });

    test("regeneration progress and error appear only on the matching card", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const listingDrafts = [genDraft("item_001"), genDraft("item_002")];
      renderView({
        confirmation,
        listingStatus: "ready",
        listingDrafts,
        regeneratingItemId: "item_001",
        regenerationError: { itemId: "item_002", message: "Listing draft regeneration failed" },
      });

      expect(within(articleFor("item_001")).getByText(/regenerating the listing draft/i)).toBeInTheDocument();
      expect(within(articleFor("item_001")).queryByRole("alert")).not.toBeInTheDocument();

      expect(within(articleFor("item_002")).getByRole("alert")).toHaveTextContent(/regeneration failed/i);
      expect(within(articleFor("item_002")).queryByText(/regenerating the listing draft/i)).not.toBeInTheDocument();
    });

    test("discard and restore call only their local actions, only for the clicked item", async () => {
      const user = userEvent.setup();
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      const listingDrafts = [genDraft("item_001"), genDraft("item_002", { is_discarded: true })];
      const { discardListingDraft, restoreListingDraft, regenerateListingDraft, editListingDraft } = renderView({
        confirmation,
        listingStatus: "ready",
        listingDrafts,
      });

      await user.click(within(articleFor("item_001")).getByRole("button", { name: /discard draft/i }));
      expect(discardListingDraft).toHaveBeenCalledTimes(1);
      expect(discardListingDraft).toHaveBeenCalledWith("item_001");

      await user.click(within(articleFor("item_002")).getByRole("button", { name: /restore draft/i }));
      expect(restoreListingDraft).toHaveBeenCalledTimes(1);
      expect(restoreListingDraft).toHaveBeenCalledWith("item_002");

      expect(regenerateListingDraft).not.toHaveBeenCalled();
      expect(editListingDraft).not.toHaveBeenCalled();
    });

    test("editing a field forwards verbatim text to editListingDraft for that item_id", async () => {
      const user = userEvent.setup();
      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      const listingDrafts = [genDraft("item_001", { edited_title: "abc" })];
      const { editListingDraft } = renderView({ confirmation, listingStatus: "ready", listingDrafts });

      await user.type(screen.getByLabelText(/listing title for/i), "X");

      expect(editListingDraft).toHaveBeenLastCalledWith("item_001", { title: "abcX" });
    });
  });

  describe("accessibility", () => {
    test("the listing surface has an accessible name in every state", () => {
      const { rerender } = render(<ListingsView confirmation={null} />);
      expect(screen.getByRole("region", { name: "Marketplace listings" })).toBeInTheDocument();

      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      rerender(<ListingsView confirmation={confirmation} listingStatus="idle" />);
      expect(screen.getByRole("region", { name: "Marketplace listings" })).toBeInTheDocument();
    });
  });

  describe("layout contracts", () => {
    test("the eligible state names the count once and its single primary action is full width on mobile, natural width from sm", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell"), decision("item_002", "sell")]);
      renderView({ confirmation, listingStatus: "idle" });
      expect(screen.getByText(/you confirmed 2 items to sell/i)).toBeInTheDocument();
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(1);
      const classes = buttons[0].className.split(/\s+/);
      for (const cls of ["w-full", "min-h-11", "sm:w-auto", "bg-primary"]) expect(classes).toContain(cls);
    });

    test("the generating state has exactly one live status, one spinner and one held-disabled control", () => {
      const confirmation = makeConfirmation([decision("item_001", "sell")]);
      const { container } = renderView({ confirmation, listingStatus: "generating" });
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toBeDisabled();
      expect(buttons[0]).toHaveAttribute("aria-busy", "true");
    });

    test("the empty Sell state is a compact calm panel with no controls", () => {
      const confirmation = makeConfirmation([decision("item_001", "keep")]);
      const { container } = renderView({ confirmation, listingStatus: "idle" });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(container.querySelector(".bg-surface-muted")).toBeTruthy();
      expect(container.className).not.toMatch(/overflow-x/);
    });
  });
});
