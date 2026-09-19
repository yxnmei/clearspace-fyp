import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ListingDraftCard from "./ListingDraftCard";

// A promise whose settlement we control, to drive "the write settles
// AFTER something else changed" races deterministically.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush the microtask chain that follows a deferred settle.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------

function makeGeneratedDraft(overrides = {}) {
  const title = overrides.title ?? "Vintage oak dining table";
  const description =
    overrides.description ??
    "Solid oak dining table in good condition, comfortably seats six people.";
  return {
    item_id: "item_001",
    effective_label: "dining table",
    status: "generated",
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
    ...overrides,
    title,
    description,
    edited_title: overrides.edited_title ?? title,
    edited_description: overrides.edited_description ?? description,
    is_edited: overrides.is_edited ?? false,
    is_discarded: overrides.is_discarded ?? false,
  };
}

function makeUnavailableDraft(overrides = {}) {
  return {
    item_id: "item_002",
    effective_label: "table lamp",
    status: "unavailable",
    title: null,
    description: null,
    was_repaired: null,
    attempts: 2,
    ...overrides,
    unavailable_reason: overrides.unavailable_reason ?? "timeout",
    edited_title: "",
    edited_description: "",
    is_edited: false,
    is_discarded: overrides.is_discarded ?? false,
  };
}

function makeReviewItem(overrides = {}) {
  return {
    item_id: "item_001",
    clean_label: "dining table",
    effective_label: "dining table",
    position: "center",
    relative_size: "large",
    confidence: 0.8,
    box: { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 },
    ...overrides,
  };
}

// A wrapper that stores edits verbatim, exactly like useDeclutterFlow's
// editListingDraft (no trim, no coerce), against the server baseline, so
// the controlled inputs behave the way they will in the real app.
function EditableCard({ draft: initialDraft, onEditSpy, ...rest }) {
  const [edited, setEdited] = useState({
    title: initialDraft.edited_title,
    description: initialDraft.edited_description,
  });
  const draft = {
    ...initialDraft,
    edited_title: edited.title,
    edited_description: edited.description,
    is_edited: edited.title !== initialDraft.title || edited.description !== initialDraft.description,
  };
  return (
    <ListingDraftCard
      {...rest}
      draft={draft}
      onEdit={(itemId, patch) => {
        onEditSpy?.(itemId, patch);
        setEdited((prev) => ({
          title: patch.title !== undefined ? patch.title : prev.title,
          description: patch.description !== undefined ? patch.description : prev.description,
        }));
      }}
    />
  );
}

// ---------------------------------------------------------------------------

describe("ListingDraftCard", () => {
  describe("identity and metadata join", () => {
    test("uses item_id for the article key and every field id, but never shows it or the location metadata", () => {
      const { container } = render(
        <ListingDraftCard
          draft={makeGeneratedDraft({ item_id: "item_007" })}
          reviewItem={makeReviewItem({ item_id: "item_007", position: "upper-right", relative_size: "small" })}
        />
      );
      expect(screen.getByRole("article")).toHaveAttribute("data-item-id", "item_007");
      expect(screen.getByLabelText(/listing title for dining table/i)).toHaveAttribute(
        "id",
        "listing-title-item_007"
      );
      expect(screen.getByLabelText(/listing description for dining table/i)).toHaveAttribute(
        "id",
        "listing-description-item_007"
      );
      expect(container.textContent).not.toMatch(/item_007|item_id|upper-right|small/i);
      expect(container.querySelector("code")).toBeNull();
    });

    test("shows no technical metadata: attempts, repair flag, status, run or model details", () => {
      const { container } = render(
        <ListingDraftCard draft={makeGeneratedDraft({ attempts: 3, was_repaired: true })} reviewItem={null} />
      );
      expect(screen.getByText("dining table")).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/item_001|attempt|repair|generated|status|run|model|prompt|sha|center/i);
    });
  });

  describe("generated draft", () => {
    test("renders controlled title/description from edited_* values", () => {
      render(
        <ListingDraftCard
          draft={makeGeneratedDraft({ edited_title: "My title", edited_description: "My description text" })}
        />
      );
      expect(screen.getByLabelText(/listing title for/i)).toHaveValue("My title");
      expect(screen.getByLabelText(/listing description for/i)).toHaveValue("My description text");
    });

    test("stores edits verbatim, without trimming or coercing", async () => {
      const user = userEvent.setup();
      const onEditSpy = vi.fn();
      render(<EditableCard draft={makeGeneratedDraft({ edited_title: "" })} onEditSpy={onEditSpy} />);

      const title = screen.getByLabelText(/listing title for/i);
      await user.type(title, "  Sofa  ");

      expect(title).toHaveValue("  Sofa  ");
      expect(onEditSpy).toHaveBeenLastCalledWith("item_001", { title: "  Sofa  " });
    });

    test("shows character counts and the backend limits, and flags intermediate invalid input", async () => {
      const user = userEvent.setup();
      render(<EditableCard draft={makeGeneratedDraft({ edited_title: "" })} />);

      const title = screen.getByLabelText(/listing title for/i);
      // empty -> invalid, count 0/120, help text with the 2..120 bound
      expect(screen.getByText("0/120")).toBeInTheDocument();
      expect(title).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText(/between 2 and 120 characters/i)).toBeInTheDocument();

      await user.type(title, "a"); // still 1 trimmed char -> still invalid, typing not blocked
      expect(title).toHaveValue("a");
      expect(title).toHaveAttribute("aria-invalid", "true");

      await user.type(title, "b"); // now 2 trimmed chars -> valid
      expect(title).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByText(/between 2 and 120 characters/i)).not.toBeInTheDocument();
    });

    test("an 'Edited' indicator appears only when is_edited is true", () => {
      const { rerender } = render(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: false })} />);
      expect(screen.queryByText("Edited")).not.toBeInTheDocument();
      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: true })} />);
      expect(screen.getByText("Edited")).toBeInTheDocument();
    });

    test("does not repeat the section-level reassurance on every card", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft()} />);
      expect(screen.queryByText(/nothing is published/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/editable suggestions/i)).not.toBeInTheDocument();
    });

    test("the header keeps thumbnail and item name together, with a subtle Edited badge when edited", () => {
      const { rerender } = render(
        <ListingDraftCard draft={makeGeneratedDraft()} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />
      );
      const heading = screen.getByRole("heading", { name: "dining table" });
      const header = heading.closest("article").firstElementChild;
      expect(header).toContainElement(screen.getByTestId("item-crop-thumbnail"));
      expect(header).toContainElement(heading);
      expect(screen.queryByText("Edited")).not.toBeInTheDocument();

      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: true })} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />);
      const edited = screen.getByText("Edited");
      expect(header).toContainElement(edited);
      expect(edited.className).toMatch(/border-border/); // outline badge, not a loud warning
    });
  });

  describe("copy listing", () => {
    test("no clipboard call happens on render", () => {
      const clipboardWriter = vi.fn().mockResolvedValue();
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);
      expect(clipboardWriter).not.toHaveBeenCalled();
    });

    test("one click produces exactly one write of '<title>\\n\\n<description>' using the edited text", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      render(
        <EditableCard
          draft={makeGeneratedDraft({ edited_title: "  Keep spaces  ", edited_description: "" })}
          clipboardWriter={clipboardWriter}
        />
      );
      // give the description a valid (>=10 trimmed) but padded value
      await user.type(screen.getByLabelText(/listing description for/i), "  padded description  ");

      await user.click(screen.getByRole("button", { name: /copy listing/i }));

      expect(clipboardWriter).toHaveBeenCalledTimes(1);
      expect(clipboardWriter).toHaveBeenCalledWith("  Keep spaces  \n\n  padded description  ");
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();
    });

    test("clipboardWriter is invoked synchronously within the click handler, before any microtask", () => {
      // Clipboard permissions depend on user activation, which is lost
      // once the writer call is deferred into a later microtask. A plain
      // synchronous fireEvent.click, with no await before the assertion,
      // proves the call already happened inside the handler itself.
      const clipboardWriter = vi.fn(() => Promise.resolve());
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      fireEvent.click(screen.getByRole("button", { name: /copy listing/i }));

      expect(clipboardWriter).toHaveBeenCalledTimes(1);
    });

    test("copy is disabled while the edited content is invalid", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft({ edited_description: "short" })} />);
      expect(screen.getByRole("button", { name: /copy listing/i })).toBeDisabled();
    });

    test("unavailable drafts render no copy control", () => {
      render(<ListingDraftCard draft={makeUnavailableDraft()} />);
      expect(screen.queryByRole("button", { name: /copy listing/i })).not.toBeInTheDocument();
    });

    test("discarded drafts render no copy control", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft({ is_discarded: true })} />);
      expect(screen.queryByRole("button", { name: /copy listing/i })).not.toBeInTheDocument();
    });

    test("a rejected write shows a generic message and never the raw browser error", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockRejectedValue(new Error("DOMException: NotAllowedltd secret"));
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      await user.click(screen.getByRole("button", { name: /copy listing/i }));

      expect(await screen.findByText(/could not copy the listing/i)).toBeInTheDocument();
      expect(screen.queryByText(/NotAllowed/)).not.toBeInTheDocument();
    });

    test("a missing / throwing Clipboard API is handled as an ordinary copy failure", async () => {
      const user = userEvent.setup();
      const clipboardWriter = () => {
        throw new Error("Clipboard API unavailable");
      };
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      await user.click(screen.getByRole("button", { name: /copy listing/i }));

      expect(await screen.findByText(/could not copy the listing/i)).toBeInTheDocument();
    });

    test("copy feedback is cleared when the draft text is edited", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      render(<EditableCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();

      await user.type(screen.getByLabelText(/listing title for/i), "!");
      expect(screen.queryByText(/copied to your clipboard/i)).not.toBeInTheDocument();
    });

    test("copy feedback is cleared when the item starts regenerating", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      const draft = makeGeneratedDraft();
      const { rerender } = render(
        <ListingDraftCard draft={draft} clipboardWriter={clipboardWriter} isRegenerating={false} />
      );

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();

      rerender(<ListingDraftCard draft={draft} clipboardWriter={clipboardWriter} isRegenerating={true} />);
      expect(screen.queryByText(/copied to your clipboard/i)).not.toBeInTheDocument();
    });

    test("copy feedback is cleared across a discard then restore", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      const { rerender } = render(
        <ListingDraftCard draft={makeGeneratedDraft({ is_discarded: false })} clipboardWriter={clipboardWriter} />
      );

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();

      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_discarded: true })} clipboardWriter={clipboardWriter} />);
      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_discarded: false })} clipboardWriter={clipboardWriter} />);
      expect(screen.queryByText(/copied to your clipboard/i)).not.toBeInTheDocument();
    });

    test("Copy can be activated from the keyboard", async () => {
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      const copy = screen.getByRole("button", { name: /copy listing/i });
      copy.focus();
      await user.keyboard("{Enter}");

      expect(clipboardWriter).toHaveBeenCalledTimes(1);
    });
  });

  describe("unavailable draft", () => {
    test("renders no fake title/description inputs", () => {
      render(<ListingDraftCard draft={makeUnavailableDraft()} />);
      expect(screen.queryByLabelText(/listing title/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/listing description/i)).not.toBeInTheDocument();
    });

    test.each([
      ["timeout", /took too long/i],
      ["service_unavailable", /service was unavailable/i],
      ["invalid_output", /response could not be used/i],
      ["generation_failed", /could not be generated/i],
    ])("maps the %s reason to a friendly message", (reason, pattern) => {
      render(<ListingDraftCard draft={makeUnavailableDraft({ unavailable_reason: reason })} />);
      expect(screen.getByText(pattern)).toBeInTheDocument();
    });

    test("allows a direct single-item regeneration with no warning", async () => {
      const user = userEvent.setup();
      const onRegenerate = vi.fn();
      render(<ListingDraftCard draft={makeUnavailableDraft()} onRegenerate={onRegenerate} />);

      await user.click(screen.getByRole("button", { name: /regenerate draft/i }));

      expect(onRegenerate).toHaveBeenCalledWith("item_002");
      expect(screen.queryByText(/replace your local edits/i)).not.toBeInTheDocument();
    });
  });

  describe("regeneration", () => {
    test("an unedited generated draft regenerates directly for its own item_id", async () => {
      const user = userEvent.setup();
      const onRegenerate = vi.fn();
      render(
        <ListingDraftCard draft={makeGeneratedDraft({ item_id: "item_009" })} onRegenerate={onRegenerate} />
      );

      await user.click(screen.getByRole("button", { name: /regenerate draft/i }));

      expect(onRegenerate).toHaveBeenCalledWith("item_009");
      expect(onRegenerate).toHaveBeenCalledTimes(1);
    });

    test("an edited draft shows an inline warning first and does not call the API until confirmed", async () => {
      const user = userEvent.setup();
      const onRegenerate = vi.fn();
      render(<EditableCard draft={makeGeneratedDraft()} onRegenerate={onRegenerate} />);

      await user.type(screen.getByLabelText(/listing title for/i), " edited");
      await user.click(screen.getByRole("button", { name: /^regenerate draft$/i }));

      expect(onRegenerate).not.toHaveBeenCalled();
      expect(screen.getByText(/will replace your local edits/i)).toBeInTheDocument();

      // Cancel dismisses without calling the API
      await user.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(screen.queryByText(/will replace your local edits/i)).not.toBeInTheDocument();

      // Re-open and confirm with the explicitly named destructive action
      await user.click(screen.getByRole("button", { name: /^regenerate draft$/i }));
      await user.click(screen.getByRole("button", { name: /replace my edits and regenerate/i }));

      expect(onRegenerate).toHaveBeenCalledTimes(1);
      expect(onRegenerate).toHaveBeenCalledWith("item_001");
    });

    test("shows accessible item-specific progress and disables the button while regenerating", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft()} isRegenerating={true} />);
      const progress = screen.getByText(/regenerating the listing draft for dining table/i);
      expect(progress.closest('[role="status"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: /regenerating/i })).toBeDisabled();
    });

    test("shows a regeneration error only when a message is passed for this card", () => {
      const { rerender } = render(<ListingDraftCard draft={makeGeneratedDraft()} regenerationErrorMessage={null} />);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      rerender(
        <ListingDraftCard draft={makeGeneratedDraft()} regenerationErrorMessage="Listing draft regeneration failed" />
      );
      expect(screen.getByRole("alert")).toHaveTextContent(/regeneration failed/i);
      expect(screen.getByRole("alert")).toHaveTextContent(/confirmed decisions are unchanged/i);
    });

    test("regenerate is disabled when another listing operation is in flight", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft()} listingBusy={true} />);
      expect(screen.getByRole("button", { name: /regenerate draft/i })).toBeDisabled();
    });
  });

  describe("local discard and restore", () => {
    test("Discard calls discardListingDraft only, for this item", async () => {
      const user = userEvent.setup();
      const onDiscard = vi.fn();
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <ListingDraftCard
          draft={makeGeneratedDraft({ item_id: "item_003" })}
          onDiscard={onDiscard}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
        />
      );

      await user.click(screen.getByRole("button", { name: /discard draft/i }));

      expect(onDiscard).toHaveBeenCalledWith("item_003");
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(onEdit).not.toHaveBeenCalled();
    });

    test("a discarded card stays visible in a compact state with identity, wording, and Restore", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft({ is_discarded: true })} reviewItem={makeReviewItem()} />);
      expect(screen.getByText("dining table")).toBeInTheDocument();
      expect(screen.getByText("Discarded")).toBeInTheDocument();
      const restore = screen.getByRole("button", { name: /restore draft/i });
      expect(restore).toBeInTheDocument();
      // low-emphasis restore, compact card, no editing surface, no raw id
      expect(restore.className).not.toMatch(/bg-primary|border-input/);
      expect(screen.queryByLabelText(/listing title/i)).not.toBeInTheDocument();
      expect(screen.getByRole("article").textContent).not.toMatch(/item_001|item_id/);
      expect(screen.getByRole("article").className).toMatch(/border-dashed/);
    });

    test("Restore calls restoreListingDraft only", async () => {
      const user = userEvent.setup();
      const onRestore = vi.fn();
      render(
        <ListingDraftCard draft={makeGeneratedDraft({ item_id: "item_004", is_discarded: true })} onRestore={onRestore} />
      );

      await user.click(screen.getByRole("button", { name: /restore draft/i }));

      expect(onRestore).toHaveBeenCalledWith("item_004");
    });
  });

  describe("accessibility", () => {
    test("every editable field has a programmatic label tied to the item", () => {
      render(
        <ListingDraftCard draft={makeGeneratedDraft({ item_id: "item_010", effective_label: "bookshelf" })} />
      );
      expect(screen.getByLabelText("Listing title for bookshelf")).toHaveAttribute("id", "listing-title-item_010");
      expect(screen.getByLabelText("Listing description for bookshelf")).toHaveAttribute(
        "id",
        "listing-description-item_010"
      );
    });

    test("no button is icon-only without an accessible name", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft()} />);
      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAccessibleName();
      }
    });

    test("the decorative thumbnail is not exposed as an image", () => {
      render(
        <ListingDraftCard draft={makeGeneratedDraft()} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />
      );
      const card = screen.getByRole("article");
      expect(within(card).queryByRole("img")).not.toBeInTheDocument();
    });
  });

  describe("stale clipboard settlements cannot restore obsolete feedback", () => {
    test("a successful copy still shows accessible 'Copied' feedback under React.StrictMode", async () => {
      // StrictMode replays the mount effect (setup -> cleanup -> setup)
      // in development while the component stays mounted. If mountedRef
      // were left false by the throwaway cleanup, every real clipboard
      // completion afterward would be silently swallowed.
      const user = userEvent.setup();
      const clipboardWriter = vi.fn().mockResolvedValue();
      render(
        <StrictMode>
          <ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />
        </StrictMode>
      );

      await user.click(screen.getByRole("button", { name: /copy listing/i }));

      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();
    });

    test("a pending successful copy cannot show 'Copied' after an edit", async () => {
      const user = userEvent.setup();
      const d = deferred();
      const clipboardWriter = vi.fn(() => d.promise);
      render(<EditableCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      await user.type(screen.getByLabelText(/listing title for/i), "!"); // edit while the write is in flight

      d.resolve();
      await flush();

      expect(screen.queryByText(/copied to your clipboard/i)).not.toBeInTheDocument();
    });

    test("a pending rejected copy cannot show an error after regeneration starts", async () => {
      const user = userEvent.setup();
      const d = deferred();
      const clipboardWriter = vi.fn(() => d.promise);
      const draft = makeGeneratedDraft();
      const { rerender } = render(
        <ListingDraftCard draft={draft} clipboardWriter={clipboardWriter} isRegenerating={false} />
      );

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      rerender(<ListingDraftCard draft={draft} clipboardWriter={clipboardWriter} isRegenerating={true} />);

      d.reject(new Error("NotAllowedError: blocked"));
      await flush();

      expect(screen.queryByText(/could not copy the listing/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/NotAllowed/)).not.toBeInTheDocument();
    });

    test("a pending copy cannot restore feedback after discard then restore", async () => {
      const user = userEvent.setup();
      const d = deferred();
      const clipboardWriter = vi.fn(() => d.promise);
      const { rerender } = render(
        <ListingDraftCard draft={makeGeneratedDraft({ is_discarded: false })} clipboardWriter={clipboardWriter} />
      );

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      rerender(
        <ListingDraftCard draft={makeGeneratedDraft({ is_discarded: true })} clipboardWriter={clipboardWriter} />
      );
      rerender(
        <ListingDraftCard draft={makeGeneratedDraft({ is_discarded: false })} clipboardWriter={clipboardWriter} />
      );

      d.resolve();
      await flush();

      expect(screen.queryByText(/copied to your clipboard/i)).not.toBeInTheDocument();
    });

    test("an older copy result cannot overwrite the outcome of a newer copy attempt", async () => {
      const user = userEvent.setup();
      const older = deferred();
      const newer = deferred();
      const clipboardWriter = vi
        .fn()
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise);
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />);

      const copy = screen.getByRole("button", { name: /copy listing/i });
      await user.click(copy); // attempt A -> older
      await user.click(copy); // attempt B -> newer

      newer.resolve();
      await flush();
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();

      older.reject(new Error("stale failure"));
      await flush();

      expect(screen.getByText(/copied to your clipboard/i)).toBeInTheDocument();
      expect(screen.queryByText(/could not copy the listing/i)).not.toBeInTheDocument();
    });

    test("a pending copy cannot write feedback after the card unmounts", async () => {
      const user = userEvent.setup();
      const d = deferred();
      const clipboardWriter = vi.fn(() => d.promise);
      const { unmount } = render(
        <ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={clipboardWriter} />
      );

      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      unmount();

      d.resolve();
      await flush(); // a setState here would surface as a test failure / act warning
    });

    test("ordinary success, rejection, synchronous throw and an unavailable API still work", async () => {
      const user = userEvent.setup();

      const ok = vi.fn().mockResolvedValue();
      const { unmount: u1 } = render(
        <ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={ok} />
      );
      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/copied to your clipboard/i)).toBeInTheDocument();
      u1();

      const rejects = vi.fn().mockRejectedValue(new Error("secret detail"));
      const { unmount: u2 } = render(
        <ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={rejects} />
      );
      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/could not copy the listing/i)).toBeInTheDocument();
      expect(screen.queryByText(/secret detail/)).not.toBeInTheDocument();
      u2();

      const throwsSync = () => {
        throw new Error("boom");
      };
      const { unmount: u3 } = render(
        <ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={throwsSync} />
      );
      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/could not copy the listing/i)).toBeInTheDocument();
      u3();

      const unavailable = () => Promise.reject(new Error("Clipboard API unavailable"));
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={unavailable} />);
      await user.click(screen.getByRole("button", { name: /copy listing/i }));
      expect(await screen.findByText(/could not copy the listing/i)).toBeInTheDocument();
    });
  });

  describe("edited-draft regeneration warning hardening", () => {
    test("with the warning open, the confirm control is disabled and does not call onRegenerate while busy", async () => {
      const user = userEvent.setup();
      const onRegenerate = vi.fn();
      // open the warning while NOT busy, then flip to busy
      function Wrapper() {
        const [busy, setBusy] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setBusy(true)}>
              go busy
            </button>
            <EditableCard draft={makeGeneratedDraft()} onRegenerate={onRegenerate} listingBusy={busy} />
          </>
        );
      }
      render(<Wrapper />);

      await user.type(screen.getByLabelText(/listing title for/i), " edited");
      await user.click(screen.getByRole("button", { name: /^regenerate draft$/i }));
      expect(screen.getByText(/will replace your local edits/i)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /go busy/i }));

      const confirm = screen.getByRole("button", { name: /replace my edits and regenerate/i });
      expect(confirm).toBeDisabled();
      await user.click(confirm);
      expect(onRegenerate).not.toHaveBeenCalled();
    });

    test("an open warning is cleared across a discard then restore, and does not reopen", () => {
      const draft = makeGeneratedDraft({ is_edited: true });
      const { rerender } = render(<ListingDraftCard draft={draft} />);
      // force the warning open by clicking the trigger
      // (is_edited true -> click shows the warning)
      act(() => {
        screen.getByRole("button", { name: /^regenerate draft$/i }).click();
      });
      expect(screen.getByText(/will replace your local edits/i)).toBeInTheDocument();

      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: true, is_discarded: true })} />);
      expect(screen.queryByText(/will replace your local edits/i)).not.toBeInTheDocument();

      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: true, is_discarded: false })} />);
      expect(screen.queryByText(/will replace your local edits/i)).not.toBeInTheDocument();
    });

    test("an open warning is cleared when regeneration begins", () => {
      const { rerender } = render(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: true })} />);
      act(() => {
        screen.getByRole("button", { name: /^regenerate draft$/i }).click();
      });
      expect(screen.getByText(/will replace your local edits/i)).toBeInTheDocument();

      rerender(<ListingDraftCard draft={makeGeneratedDraft({ is_edited: true })} isRegenerating={true} />);
      expect(screen.queryByText(/will replace your local edits/i)).not.toBeInTheDocument();
    });
  });

  describe("action hierarchy and responsive layout", () => {
    test("Copy is the single primary action, Regenerate secondary (outline) and Discard tertiary (ghost, muted)", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft()} />);
      const copy = screen.getByRole("button", { name: /copy listing/i });
      const regenerate = screen.getByRole("button", { name: /regenerate draft/i });
      const discard = screen.getByRole("button", { name: /discard draft/i });

      expect(copy.className).toMatch(/\bbg-primary\b/);
      expect(regenerate.className).toMatch(/\bborder-input\b/);
      expect(regenerate.className).not.toMatch(/\bbg-primary\b/);
      expect(discard.className).not.toMatch(/\bbg-primary\b|\bborder-input\b/);
      expect(discard.className).toMatch(/text-muted-foreground/);
      // only one primary-styled button on the card
      expect(screen.getAllByRole("button").filter((b) => /\bbg-primary\b/.test(b.className))).toHaveLength(1);
    });

    test("Copy is full width with a 44px target on mobile and natural width from sm; the secondary actions wrap beneath it without overflow classes", () => {
      render(<ListingDraftCard draft={makeGeneratedDraft()} />);
      const copy = screen.getByRole("button", { name: /copy listing/i });
      const classes = copy.className.split(/\s+/);
      for (const cls of ["w-full", "min-h-11", "sm:w-auto"]) expect(classes).toContain(cls);

      const actions = copy.parentElement;
      expect(actions.className).toMatch(/\bflex-col\b/);
      expect(actions.className).toMatch(/\bsm:flex-row\b/);
      const secondary = screen.getByRole("button", { name: /regenerate draft/i }).parentElement;
      expect(secondary.className).toMatch(/\bflex-wrap\b/);
      expect(secondary).toContainElement(screen.getByRole("button", { name: /discard draft/i }));
      expect(screen.getByRole("article").className).not.toMatch(/overflow-x|whitespace-nowrap|w-screen/);
    });

    test("copy feedback sits directly under the actions and is described by the Copy button", async () => {
      const user = userEvent.setup();
      render(<ListingDraftCard draft={makeGeneratedDraft()} clipboardWriter={vi.fn().mockResolvedValue()} />);
      const copy = screen.getByRole("button", { name: /copy listing/i });
      await user.click(copy);
      const status = await screen.findByText(/copied to your clipboard/i);
      expect(status.closest("p")).toHaveAttribute("id", copy.getAttribute("aria-describedby"));
      expect(copy.parentElement.nextElementSibling).toBe(status.closest("p"));
    });

    test("an unavailable draft keeps its identity, the safe reason, Regenerate as recovery and a tertiary Discard, with no internal codes", () => {
      const { container } = render(
        <ListingDraftCard draft={makeUnavailableDraft({ unavailable_reason: "service_unavailable" })} reviewItem={makeReviewItem()} />
      );
      expect(screen.getByRole("heading", { name: "table lamp" })).toBeInTheDocument();
      expect(screen.getByText(/service was unavailable/i)).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/service_unavailable|unavailable_reason|item_00\d|status/i);
      expect(screen.getByRole("button", { name: /regenerate draft/i }).className).toMatch(/\bborder-input\b/);
      expect(screen.getByRole("button", { name: /discard draft/i }).className).toMatch(/text-muted-foreground/);
      expect(screen.queryByRole("button", { name: /copy listing/i })).not.toBeInTheDocument();
    });
  });
});
