import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useDeclutterFlow } from "./useDeclutterFlow";
import * as client from "../api/client";
// listingContract is NOT mocked: the real normalisers run inside the
// injected listingApi seam, so these tests exercise the genuine
// hook <-> contract integration, not just mocked call wiring.
import { normaliseListingResponse, normaliseSingleListingResponse } from "../api/listingContract";

// Only the frontend API functions are mocked, normaliseDeclutterUploadResponse/
// normaliseConfirmationResponse (the pure contract adapters) run for real, so
// these tests also prove the hook wires real, validating adapters correctly,
// not just that it calls the right mocked functions.
vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
  // Present so the hook's `import { generateListings, regenerateListing }`
  // resolves; listing tests inject their own `listingApi` seam and never
  // rely on these module-level mocks.
  generateListings: vi.fn(),
  regenerateListing: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeFile(name = "room.jpg") {
  return new File(["fake bytes"], name, { type: "image/jpeg" });
}

function makeUploadResponse({ itemIds = ["item_001"], runId = "run1" } = {}) {
  const items = itemIds.map((id, i) => ({
    item_id: id,
    source_detection_index: i,
    raw_phrase: `raw-${id}`,
    clean_label: `label-${id}`,
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    confidence: 0.8,
    position: "upper-left",
    relative_size: "small",
    item_role: "actionable",
    item_role_source: "default",
    corrected_label: null,
    label_source: "detector",
    effective_label: `label-${id}`,
  }));
  return {
    run_id: runId,
    path: "declutter",
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items,
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: runId,
      expected_item_ids: itemIds,
      ai_decisions: itemIds.map((id) => ({ item_id: id, decision: "keep", reason: `reason for ${id}` })),
      unresolved_item_ids: [],
      item_validity: Object.fromEntries(itemIds.map((id) => [id, "raw_valid"])),
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

function makeIncompleteUploadResponse(runId = "run1") {
  return {
    run_id: runId,
    path: "declutter",
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items: [
        {
          item_id: "item_001",
          source_detection_index: 0,
          raw_phrase: "lamp",
          clean_label: "lamp",
          box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
          confidence: 0.5,
          position: "upper-left",
          relative_size: "small",
          item_role: "actionable",
          item_role_source: "default",
          corrected_label: null,
          label_source: "detector",
          effective_label: "lamp",
        },
      ],
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: runId,
      expected_item_ids: ["item_001"],
      ai_decisions: [],
      unresolved_item_ids: ["item_001"],
      item_validity: { item_001: "still_invalid" },
      mapping_warnings: [],
      semantic_errors: [],
      recovery_failures: [],
      provenance_warnings: [],
      is_complete: false,
      is_strictly_valid: false,
      model_name: "phi4-mini",
      prompt_version: "v2",
      stage_timings: [],
    },
  };
}

function makeConfirmResponse(overrides = {}) {
  return {
    run_id: "run1",
    confirmed_decisions: [
      {
        item_id: "item_001",
        ai_decision: "keep",
        confirmed_decision: "keep",
        ai_reason: "reason for item_001",
        user_reason: null,
        excluded: false,
        decision_changed: false,
      },
    ],
    confirmed_keep_ids: ["item_001"],
    decision_changed_count: 0,
    excluded_count: 0,
    ...overrides,
  };
}

function makeOverrideResponse({
  runId = "run1",
  itemId = "item_001",
  correctedLabel = "hoodie",
  decision = "sell",
  reason = "still wearable",
  validity = "raw_valid",
  cleanLabel = "box",
} = {}) {
  return {
    run_id: runId,
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items: [
        {
          item_id: itemId,
          source_detection_index: 0,
          raw_phrase: cleanLabel,
          clean_label: cleanLabel,
          box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
          confidence: 0.8,
          position: "upper-left",
          relative_size: "small",
          item_role: "actionable",
          item_role_source: "default",
          corrected_label: correctedLabel,
          label_source: "user",
          effective_label: correctedLabel,
        },
      ],
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: runId,
      expected_item_ids: [itemId],
      ai_decisions: decision ? [{ item_id: itemId, decision, reason }] : [],
      unresolved_item_ids: decision ? [] : [itemId],
      item_validity: { [itemId]: validity },
      mapping_warnings: [],
      semantic_errors: [],
      recovery_failures: [],
      provenance_warnings: [],
      is_complete: Boolean(decision),
      is_strictly_valid: validity === "raw_valid" && Boolean(decision),
      model_name: "phi4-mini",
      prompt_version: "v2",
      stage_timings: [],
    },
  };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useDeclutterFlow", () => {
  test("successful upload stores normalized analysis/declutter/items", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.runId).toBe("run1");
    expect(result.current.analysis.scene.label).toBe("bedroom");
    expect(result.current.declutter.expected_item_ids).toEqual(["item_001"]);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.reviewItems).toHaveLength(1);
    expect(result.current.reviewItems[0].ai_decision).toBe("keep");
  });

  test("upload failure enters error state", async () => {
    client.uploadImage.mockRejectedValue(new Error("<html>proxy failure</html>"));
    const { result } = renderHook(() => useDeclutterFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("We couldn't analyse your space.");
    expect(result.current.error).not.toMatch(/html|proxy/i);
  });

  test("decision override updates reviewItems", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    expect(result.current.reviewItems[0].review_decision).toBe("donate");
    expect(result.current.reviewItems[0].decision_changed).toBe(true);
  });

  test("confirmation sends serialized overrides in expected-item order", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse({ itemIds: ["item_001", "item_002"] }));
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse({
        confirmed_decisions: [
          {
            item_id: "item_001",
            ai_decision: "keep",
            confirmed_decision: "donate",
            ai_reason: "reason for item_001",
            user_reason: null,
            excluded: false,
            decision_changed: true,
          },
          {
            item_id: "item_002",
            ai_decision: "keep",
            confirmed_decision: "donate",
            ai_reason: "reason for item_002",
            user_reason: null,
            excluded: false,
            decision_changed: true,
          },
        ],
        confirmed_keep_ids: [],
        decision_changed_count: 2,
      })
    );

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    // Set item_002's override first, item_001's second, proves
    // serialization order follows expected_item_ids, not call order.
    act(() => {
      result.current.setDecisionOverride("item_002", "donate");
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    await act(async () => {
      await result.current.confirm();
    });

    const [callArgs] = client.confirmDecisions.mock.calls[0];
    expect(callArgs.overrides.map((o) => o.item_id)).toEqual(["item_001", "item_002"]);
  });

  test("successful confirmation stores normalized result", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.confirmDecisions.mockResolvedValue(makeConfirmResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(result.current.confirmation.confirmedKeepIds).toEqual(["item_001"]);
  });

  test("confirmation failure preserves overrides and Declutter data", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.confirmDecisions.mockRejectedValue(new Error("Traceback: confirmation_service.py"));
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.confirmationStatus).toBe("error");
    expect(result.current.confirmationError).toBe("We couldn't confirm your decisions.");
    expect(result.current.declutter).not.toBeNull();
    expect(result.current.overridesById.item_001.decision).toBe("donate");
  });

  test("incomplete Declutter result blocks the network call", async () => {
    client.uploadImage.mockResolvedValue(makeIncompleteUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let confirmResult;
    await act(async () => {
      confirmResult = await result.current.confirm();
    });

    expect(confirmResult).toBeNull();
    expect(client.confirmDecisions).not.toHaveBeenCalled();
    expect(result.current.confirmationStatus).toBe("error");
  });

  test("editing after confirmation invalidates the result", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.confirmDecisions.mockResolvedValue(makeConfirmResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.confirmation).not.toBeNull();

    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    expect(result.current.confirmation).toBeNull();
    expect(result.current.confirmationStatus).toBe("idle");
  });

  test("a stale in-flight confirmation success is ignored after an edit", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const deferred = makeDeferred();
    client.confirmDecisions.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let confirmPromise;
    act(() => {
      confirmPromise = result.current.confirm(); // in-flight, not yet resolved
    });
    expect(result.current.confirmationStatus).toBe("confirming");

    // Edit while the request is outstanding, must invalidate its generation.
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    expect(result.current.confirmationStatus).toBe("idle");

    // Now let the stale request resolve.
    await act(async () => {
      deferred.resolve(makeConfirmResponse());
      await confirmPromise;
    });

    expect(result.current.confirmation).toBeNull(); // discarded, not applied
    expect(result.current.confirmationStatus).toBe("idle"); // untouched by the stale success
  });

  test("an older confirmation response cannot overwrite a newer one", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const firstDeferred = makeDeferred();
    const newerResponse = makeConfirmResponse({
      confirmed_decisions: [
        {
          item_id: "item_001",
          ai_decision: "keep",
          confirmed_decision: "donate",
          ai_reason: "reason for item_001",
          user_reason: null,
          excluded: false,
          decision_changed: true,
        },
      ],
      confirmed_keep_ids: [],
      decision_changed_count: 1,
    });
    client.confirmDecisions.mockReturnValueOnce(firstDeferred.promise).mockResolvedValueOnce(newerResponse);

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let firstConfirmPromise;
    act(() => {
      firstConfirmPromise = result.current.confirm(); // older, still pending
    });

    await act(async () => {
      await result.current.confirm(); // newer, resolves immediately
    });

    expect(result.current.confirmation.confirmedDecisions[0].confirmed_decision).toBe("donate");

    // Resolve the OLDER request now, it must not clobber the newer state.
    await act(async () => {
      firstDeferred.resolve(makeConfirmResponse()); // the stale "keep" response
      await firstConfirmPromise;
    });

    expect(result.current.confirmation.confirmedDecisions[0].confirmed_decision).toBe("donate"); // unchanged
  });

  test("starting a new upload invalidates an in-flight confirmation", async () => {
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ itemIds: ["item_001"] }));
    const deferred = makeDeferred();
    client.confirmDecisions.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let confirmPromise;
    act(() => {
      confirmPromise = result.current.confirm();
    });

    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ itemIds: ["item_002"] }));
    await act(async () => {
      await result.current.submit({ file: makeFile("room2.jpg"), context: null });
    });

    await act(async () => {
      deferred.resolve(makeConfirmResponse());
      await confirmPromise;
    });

    expect(result.current.confirmation).toBeNull();
    expect(result.current.declutter.expected_item_ids).toEqual(["item_002"]); // the new upload's data, untouched
  });

  test("an older upload response cannot overwrite a newer one", async () => {
    const firstDeferred = makeDeferred();
    client.uploadImage.mockReturnValueOnce(firstDeferred.promise).mockResolvedValueOnce(makeUploadResponse({ itemIds: ["item_002"] }));

    const { result } = renderHook(() => useDeclutterFlow());

    let firstSubmitPromise;
    act(() => {
      firstSubmitPromise = result.current.submit({ file: makeFile("a.jpg"), context: null }); // older, still pending
    });

    await act(async () => {
      await result.current.submit({ file: makeFile("b.jpg"), context: null }); // newer, resolves immediately
    });

    expect(result.current.declutter.expected_item_ids).toEqual(["item_002"]);

    await act(async () => {
      firstDeferred.resolve(makeUploadResponse({ itemIds: ["item_001"] })); // the stale response
      await firstSubmitPromise;
    });

    expect(result.current.declutter.expected_item_ids).toEqual(["item_002"]); // unchanged by the stale response
  });
});

describe("useDeclutterFlow correctLabel", () => {
  test("the original user context reaches overrideItem", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.overrideItem.mockResolvedValue(makeOverrideResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: "downsizing before a move" });
    });

    await act(async () => {
      await result.current.correctLabel("item_001", "hoodie");
    });

    expect(client.overrideItem).toHaveBeenCalledWith(
      expect.objectContaining({ userContext: "downsizing before a move", itemId: "item_001", correctedLabel: "hoodie" })
    );
  });

  test("a resolved expected item can be corrected and the response replaces analysis/declutter/items", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.overrideItem.mockResolvedValue(makeOverrideResponse({ decision: "sell" }));
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let correctResult;
    await act(async () => {
      correctResult = await result.current.correctLabel("item_001", "hoodie");
    });

    expect(correctResult).not.toBeNull();
    expect(result.current.items[0].effective_label).toBe("hoodie");
    expect(result.current.items[0].label_source).toBe("user");
    expect(result.current.declutter.ai_decisions[0].decision).toBe("sell");
    expect(result.current.correctingItemId).toBeNull();
    expect(result.current.correctionError).toBeNull();
  });

  test("an unresolved expected item can be corrected", async () => {
    client.uploadImage.mockResolvedValue(makeIncompleteUploadResponse());
    client.overrideItem.mockResolvedValue(makeOverrideResponse({ decision: "donate" }));
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    expect(result.current.declutter.unresolved_item_ids).toEqual(["item_001"]);

    await act(async () => {
      await result.current.correctLabel("item_001", "hoodie");
    });

    expect(result.current.declutter.unresolved_item_ids).toEqual([]);
    expect(result.current.declutter.is_complete).toBe(true);
  });

  test("a contextual item is rejected without making a request", async () => {
    const response = makeUploadResponse();
    response.analysis.items.push({
      item_id: "item_099",
      source_detection_index: 1,
      raw_phrase: "wall",
      clean_label: "wall",
      box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
      confidence: 0.8,
      position: "center",
      relative_size: "large",
      item_role: "contextual",
      item_role_source: "default",
      corrected_label: null,
      label_source: "detector",
      effective_label: "wall",
    });
    client.uploadImage.mockResolvedValue(response);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(() => result.current.correctLabel("item_099", "picture")).toThrow(/not an expected item/);
    expect(client.overrideItem).not.toHaveBeenCalled();
  });

  test("an unknown item id is rejected without making a request", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(() => result.current.correctLabel("item_999", "hoodie")).toThrow(/not an expected item/);
    expect(client.overrideItem).not.toHaveBeenCalled();
  });

  test("a blank correctedLabel is rejected without making a request", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(() => result.current.correctLabel("item_001", "   ")).toThrow(/non-empty string/);
    expect(client.overrideItem).not.toHaveBeenCalled();
  });

  test("failure leaves existing flow and decision overrides unchanged, and surfaces a concise error", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.overrideItem.mockRejectedValue(new Error("POST /override failed: 500 internal stack"));
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    await act(async () => {
      await result.current.correctLabel("item_001", "hoodie");
    });

    expect(result.current.correctingItemId).toBeNull();
    expect(result.current.correctionError).toEqual({
      itemId: "item_001",
      message: "We couldn't update that label.",
    });
    expect(result.current.declutter.ai_decisions[0].decision).toBe("keep"); // untouched
    expect(result.current.overridesById.item_001.decision).toBe("donate"); // untouched
  });

  test("existing decision overrides survive a successful label correction", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.overrideItem.mockResolvedValue(makeOverrideResponse({ decision: "sell" }));
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    await act(async () => {
      await result.current.correctLabel("item_001", "hoodie");
    });

    expect(result.current.overridesById.item_001.decision).toBe("donate"); // the user's own choice, preserved
    expect(result.current.reviewItems[0].review_decision).toBe("donate");
    expect(result.current.reviewItems[0].ai_decision).toBe("sell"); // the fresh AI suggestion, for comparison
  });

  test("confirmation is invalidated and blocked while a correction is in flight", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.confirmDecisions.mockResolvedValue(makeConfirmResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.confirmation).not.toBeNull();

    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);
    act(() => {
      result.current.correctLabel("item_001", "hoodie");
    });

    expect(result.current.confirmation).toBeNull(); // invalidated as soon as the correction begins
    expect(result.current.correctingItemId).toBe("item_001");

    let blockedResult;
    await act(async () => {
      blockedResult = await result.current.confirm();
    });
    expect(blockedResult).toBeNull();
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1); // no second call while correcting
    // The blocked call is state-neutral, it must not leave a fake
    // "confirming"/"error" status sitting around while the real
    // correction is still in flight.
    expect(result.current.confirmationStatus).toBe("idle");
    expect(result.current.confirmationError).toBeNull();

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ decision: "sell" }));
    });
  });

  test("a confirm() blocked by an in-flight correction leaves no stale error once the correction finishes", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    act(() => {
      result.current.correctLabel("item_001", "hoodie"); // begins, still pending
    });
    expect(result.current.correctingItemId).toBe("item_001");

    let blockedResult;
    await act(async () => {
      blockedResult = await result.current.confirm(); // blocked while correction is active
    });
    expect(blockedResult).toBeNull();

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ decision: "sell" })); // correction finishes
    });

    expect(result.current.correctingItemId).toBeNull();
    // No stale "correction in progress" (or any other) error is left
    // visible now that the correction that blocked confirm() is done.
    expect(result.current.confirmationStatus).toBe("idle");
    expect(result.current.confirmationError).toBeNull();
  });

  test("starting a correction, changing a decision override, then resolving the correction: all state survives correctly", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.confirmDecisions.mockResolvedValue(makeConfirmResponse());
    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.confirmation).not.toBeNull();

    act(() => {
      result.current.correctLabel("item_001", "hoodie"); // begins, still pending
    });
    expect(result.current.correctingItemId).toBe("item_001");
    expect(result.current.confirmation).toBeNull(); // invalidated when the correction began

    // A decision edit while the correction is still in flight must NOT
    // invalidate the correction itself, this is the regression this
    // task fixes: it used to make the correction's own response look
    // stale, leaving correctingItemId stuck non-null forever.
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    expect(result.current.overridesById.item_001.decision).toBe("donate");

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ decision: "sell" }));
    });

    // The correction was NOT discarded as stale, it fully applied.
    expect(result.current.correctingItemId).toBeNull();
    expect(result.current.items[0].effective_label).toBe("hoodie");
    expect(result.current.declutter.ai_decisions[0].decision).toBe("sell");
    // The user's own decision override survives the correction.
    expect(result.current.overridesById.item_001.decision).toBe("donate");
    expect(result.current.reviewItems[0].review_decision).toBe("donate");
    // Confirmation remains invalidated (the edit also invalidated it,
    // redundantly with the correction, either way it must stay cleared).
    expect(result.current.confirmation).toBeNull();
    expect(result.current.confirmationStatus).toBe("idle");
  });

  test("starting a correction, then excluding the item, then resolving the correction: all state survives correctly", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    act(() => {
      result.current.correctLabel("item_001", "hoodie");
    });
    expect(result.current.correctingItemId).toBe("item_001");

    act(() => {
      result.current.setItemExcluded("item_001", true);
    });
    expect(result.current.overridesById.item_001.excluded).toBe(true);

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ decision: "sell" }));
    });

    expect(result.current.correctingItemId).toBeNull(); // not stuck, the correction was not discarded as stale
    expect(result.current.items[0].effective_label).toBe("hoodie");
    expect(result.current.overridesById.item_001.excluded).toBe(true); // survives
    expect(result.current.reviewItems[0].review_excluded).toBe(true);
  });

  test("starting a correction, then clearing an existing decision override, then resolving the correction", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    expect(result.current.overridesById.item_001.decision).toBe("donate");

    act(() => {
      result.current.correctLabel("item_001", "hoodie");
    });
    expect(result.current.correctingItemId).toBe("item_001");

    act(() => {
      result.current.clearDecisionOverride("item_001");
    });
    expect(result.current.overridesById.item_001).toBeUndefined();

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ decision: "sell" }));
    });

    expect(result.current.correctingItemId).toBeNull(); // not stuck
    expect(result.current.items[0].effective_label).toBe("hoodie");
    expect(result.current.overridesById.item_001).toBeUndefined(); // the clear survives too
    expect(result.current.reviewItems[0].review_decision).toBe("sell"); // falls back to the fresh AI decision
  });

  test("an old correction cannot overwrite a newer correction of the same item", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const firstDeferred = makeDeferred();
    client.overrideItem
      .mockReturnValueOnce(firstDeferred.promise)
      .mockResolvedValueOnce(makeOverrideResponse({ correctedLabel: "sweater", decision: "donate" }));

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let firstCorrectPromise;
    act(() => {
      firstCorrectPromise = result.current.correctLabel("item_001", "hoodie"); // older, still pending
    });

    await act(async () => {
      await result.current.correctLabel("item_001", "sweater"); // newer, resolves immediately
    });

    expect(result.current.items[0].effective_label).toBe("sweater");

    await act(async () => {
      firstDeferred.resolve(makeOverrideResponse({ correctedLabel: "hoodie", decision: "sell" })); // the stale response
      await firstCorrectPromise;
    });

    expect(result.current.items[0].effective_label).toBe("sweater"); // unchanged by the stale response
  });

  test("a new upload invalidates an in-flight correction", async () => {
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ itemIds: ["item_001"] }));
    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let correctPromise;
    act(() => {
      correctPromise = result.current.correctLabel("item_001", "hoodie");
    });

    client.uploadImage.mockResolvedValueOnce(makeUploadResponse({ itemIds: ["item_002"] }));
    await act(async () => {
      await result.current.submit({ file: makeFile("room2.jpg"), context: null });
    });

    await act(async () => {
      deferred.resolve(makeOverrideResponse());
      await correctPromise;
    });

    expect(result.current.declutter.expected_item_ids).toEqual(["item_002"]); // the new upload's data, untouched
    expect(result.current.correctingItemId).toBeNull();
  });

  test("an old confirmation cannot overwrite state after a correction begins", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const confirmDeferred = makeDeferred();
    client.confirmDecisions.mockReturnValueOnce(confirmDeferred.promise);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let confirmPromise;
    act(() => {
      confirmPromise = result.current.confirm(); // in-flight
    });

    client.overrideItem.mockResolvedValue(makeOverrideResponse({ decision: "sell" }));
    await act(async () => {
      await result.current.correctLabel("item_001", "hoodie"); // begins and completes
    });

    await act(async () => {
      confirmDeferred.resolve(makeConfirmResponse()); // the stale confirmation response, resolves late
      await confirmPromise;
    });

    expect(result.current.confirmation).toBeNull(); // never applied
    expect(result.current.confirmationStatus).toBe("idle");
  });

  test("a stale failed correction produces no stale error state", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const firstDeferred = makeDeferred();
    client.overrideItem
      .mockReturnValueOnce(firstDeferred.promise)
      .mockResolvedValueOnce(makeOverrideResponse({ correctedLabel: "sweater", decision: "donate" }));

    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let firstCorrectPromise;
    act(() => {
      firstCorrectPromise = result.current.correctLabel("item_001", "hoodie"); // older, still pending
    });

    await act(async () => {
      await result.current.correctLabel("item_001", "sweater"); // newer, resolves successfully
    });
    expect(result.current.correctionError).toBeNull();

    await act(async () => {
      firstDeferred.reject(new Error("stale failure")); // the OLDER request fails, late
      await firstCorrectPromise;
    });

    expect(result.current.correctionError).toBeNull(); // the stale failure must not surface
    expect(result.current.items[0].effective_label).toBe("sweater"); // the newer success stands
  });

  test("correcting a different item while one is in flight is a silent no-op", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse({ itemIds: ["item_001", "item_002"] }));
    const deferred = makeDeferred();
    client.overrideItem.mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    act(() => {
      result.current.correctLabel("item_001", "hoodie");
    });
    expect(result.current.correctingItemId).toBe("item_001");

    let blockedResult;
    await act(async () => {
      blockedResult = await result.current.correctLabel("item_002", "sweater");
    });

    expect(blockedResult).toBeNull();
    expect(client.overrideItem).toHaveBeenCalledTimes(1); // item_002's attempt never fired

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ itemId: "item_001" }));
    });
  });
});

describe("useDeclutterFlow, configurable uploadPath/normaliseUploadResponse (R6)", () => {
  test("default parameters reproduce existing Declutter behavior exactly, no arguments needed", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ path: "declutter" }));
    expect(result.current.status).toBe("ready");
    expect(result.current.inputImageSha256).toBeNull(); // never set by normaliseDeclutterUploadResponse
  });

  test("a configured uploadPath is sent to uploadImage instead of the default", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow({ uploadPath: "both" }));

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ path: "both" }));
  });

  test("a configured normaliseUploadResponse is used instead of the default, and its extra fields surface", async () => {
    const rawResponse = makeUploadResponse();
    client.uploadImage.mockResolvedValue(rawResponse);
    const customNormaliser = vi.fn((response) => ({
      runId: response.run_id,
      analysis: response.analysis,
      declutter: response.declutter,
      items: [],
      inputImageSha256: "b".repeat(64),
    }));

    const { result } = renderHook(() => useDeclutterFlow({ normaliseUploadResponse: customNormaliser }));

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(customNormaliser).toHaveBeenCalledWith(rawResponse);
    expect(result.current.inputImageSha256).toBe("b".repeat(64));
  });
});

describe("useDeclutterFlow, reset() (R6)", () => {
  test("reset() clears analysis, declutter, overrides, confirmation, and errors, returning to idle", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    client.confirmDecisions.mockResolvedValue(makeConfirmResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.confirmation).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.analysis).toBeNull();
    expect(result.current.declutter).toBeNull();
    expect(result.current.items).toEqual([]);
    expect(result.current.overridesById).toEqual({});
    expect(result.current.confirmation).toBeNull();
    expect(result.current.confirmationStatus).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  test("reset() invalidates an in-flight upload, a stale response never resurrects state", async () => {
    const { result } = renderHook(() => useDeclutterFlow());
    const deferred = makeDeferred();
    client.uploadImage.mockReturnValueOnce(deferred.promise);

    let submitPromise;
    act(() => {
      submitPromise = result.current.submit({ file: makeFile(), context: null });
    });
    expect(result.current.status).toBe("uploading");

    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      deferred.resolve(makeUploadResponse());
      await submitPromise;
    });

    expect(result.current.status).toBe("idle"); // the stale success never applied
    expect(result.current.analysis).toBeNull();
  });

  test("reset() invalidates an in-flight confirmation, a stale response never resurrects state", async () => {
    client.uploadImage.mockResolvedValue(makeUploadResponse());
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    const deferred = makeDeferred();
    client.confirmDecisions.mockReturnValueOnce(deferred.promise);
    let confirmPromise;
    act(() => {
      confirmPromise = result.current.confirm();
    });
    expect(result.current.confirmationStatus).toBe("confirming");

    act(() => {
      result.current.reset();
    });

    await act(async () => {
      deferred.resolve(makeConfirmResponse());
      await confirmPromise;
    });

    expect(result.current.confirmation).toBeNull();
    expect(result.current.confirmationStatus).toBe("idle");
  });
});

// ===========================================================================
// Marketplace listing domain
// ===========================================================================

// specs: [{ id, ai, decision?, excluded?, label }]
function listUpload(specs, runId = "run1") {
  const items = specs.map((s, i) => ({
    item_id: s.id,
    source_detection_index: i,
    raw_phrase: s.label,
    clean_label: s.label,
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    confidence: 0.8,
    position: "upper-left",
    relative_size: "small",
    item_role: "actionable",
    item_role_source: "default",
    corrected_label: null,
    label_source: "detector",
    effective_label: s.label,
  }));
  return {
    run_id: runId,
    path: "declutter",
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items,
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: runId,
      expected_item_ids: specs.map((s) => s.id),
      ai_decisions: specs.map((s) => ({ item_id: s.id, decision: s.ai, reason: `reason for ${s.id}` })),
      unresolved_item_ids: [],
      item_validity: Object.fromEntries(specs.map((s) => [s.id, "raw_valid"])),
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

function listConfirmResponse(specs, runId = "run1") {
  const cds = specs.map((s) => ({
    item_id: s.id,
    ai_decision: s.ai,
    confirmed_decision: s.decision ?? s.ai,
    ai_reason: `reason for ${s.id}`,
    user_reason: null,
    excluded: s.excluded ?? false,
    decision_changed: (s.decision ?? s.ai) !== s.ai,
  }));
  return {
    run_id: runId,
    confirmed_decisions: cds,
    confirmed_keep_ids: cds.filter((c) => c.confirmed_decision === "keep" && !c.excluded).map((c) => c.item_id),
    decision_changed_count: cds.filter((c) => c.decision_changed).length,
    excluded_count: cds.filter((c) => c.excluded).length,
  };
}

function genDraft(id, label, over = {}) {
  return {
    item_id: id,
    effective_label: label,
    status: "generated",
    title: "Wooden chair",
    description: "A used wooden chair in ordinary condition.",
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
    ...over,
  };
}

function unavailDraft(id, label, over = {}) {
  return {
    item_id: id,
    effective_label: label,
    status: "unavailable",
    title: null,
    description: null,
    unavailable_reason: "generation_failed",
    was_repaired: null,
    attempts: 3,
    ...over,
  };
}

function batchResp(confirmResponse, drafts, runId = "run1") {
  const nonEmpty = drafts.length > 0;
  return {
    run_id: runId,
    confirmation: JSON.parse(JSON.stringify(confirmResponse)),
    drafts,
    model_name: nonEmpty ? "phi4-mini" : null,
    prompt_version: nonEmpty ? "v1" : null,
    max_attempts: nonEmpty ? 3 : null,
  };
}

function singleResp(confirmResponse, draft, over = {}) {
  return {
    run_id: "run1",
    confirmation: JSON.parse(JSON.stringify(confirmResponse)),
    draft,
    model_name: "phi4-mini",
    prompt_version: "v1",
    max_attempts: 3,
    ...over,
  };
}

function makeListingApi(over = {}) {
  return {
    generateListings: vi.fn(),
    regenerateListing: vi.fn(),
    normaliseListingResponse,
    normaliseSingleListingResponse,
    ...over,
  };
}

// upload -> confirm, listingApi injected, returns { result, listingApi, confirmResponse }
async function primeConfirmed(specs, { listingApi = makeListingApi(), beforeConfirm } = {}) {
  client.uploadImage.mockResolvedValue(listUpload(specs));
  const confirmResponse = listConfirmResponse(specs);
  client.confirmDecisions.mockResolvedValue(confirmResponse);
  const { result } = renderHook(() => useDeclutterFlow({ listingApi }));
  await act(async () => {
    await result.current.submit({ file: makeFile(), context: null });
  });
  if (beforeConfirm) {
    await act(async () => {
      beforeConfirm(result);
    });
  }
  await act(async () => {
    await result.current.confirm();
  });
  return { result, listingApi, confirmResponse };
}

// ...and then generateListingDrafts() to a ready result.
async function primeReady(specs, opts = {}) {
  const ctx = await primeConfirmed(specs, opts);
  const drafts =
    opts.drafts ??
    specs
      .filter((s) => (s.decision ?? s.ai) === "sell" && !s.excluded)
      .map((s) => genDraft(s.id, s.label));
  ctx.listingApi.generateListings.mockResolvedValue(batchResp(ctx.confirmResponse, drafts));
  await act(async () => {
    await ctx.result.current.generateListingDrafts();
  });
  return { ...ctx, drafts };
}

const TWO_SELL = [
  { id: "item_001", ai: "sell", label: "lamp" },
  { id: "item_002", ai: "keep", label: "chair" },
  { id: "item_003", ai: "sell", label: "book" },
];

describe("useDeclutterFlow, marketplace listing domain (Stage 3)", () => {
  test("confirmation success never auto-generates listing drafts", async () => {
    const { result, listingApi } = await primeConfirmed(TWO_SELL);
    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(listingApi.generateListings).not.toHaveBeenCalled();
    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.listingDrafts).toEqual([]);
  });

  test("generateListingDrafts is a no-op with no request before a successful confirmation", async () => {
    client.uploadImage.mockResolvedValue(listUpload(TWO_SELL));
    const listingApi = makeListingApi();
    const { result } = renderHook(() => useDeclutterFlow({ listingApi }));
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let out;
    await act(async () => {
      out = await result.current.generateListingDrafts();
    });
    expect(out).toBeNull();
    expect(listingApi.generateListings).not.toHaveBeenCalled();
    expect(result.current.listingStatus).toBe("idle");
  });

  test("generateListingDrafts sends the exact { runId, analysis, declutter, overrides } payload", async () => {
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_SELL);
    listingApi.generateListings.mockResolvedValue(
      batchResp(confirmResponse, [genDraft("item_001", "lamp"), genDraft("item_003", "book")])
    );

    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(listingApi.generateListings).toHaveBeenCalledTimes(1);
    expect(listingApi.generateListings).toHaveBeenCalledWith({
      runId: "run1",
      analysis: result.current.analysis,
      declutter: result.current.declutter,
      overrides: [],
      // one entry per eligible Sell item, in confirmation order, defaulting
      // to the reviewed label and "not specified"
      listingDetails: [
        { item_id: "item_001", listing_name: "lamp", condition: "not_specified" },
        { item_id: "item_003", listing_name: "book", condition: "not_specified" },
      ],
    });
  });

  test("generateListingDrafts validates through normaliseListingResponse with current snapshots", async () => {
    const spy = vi.fn((response) => ({
      runId: "run1",
      confirmation: { runId: "run1" },
      eligibleItemIds: ["item_001", "item_003"],
      drafts: [],
      modelName: "phi4-mini",
      promptVersion: "v1",
      maxAttempts: 3,
    }));
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_SELL, {
      listingApi: makeListingApi({ normaliseListingResponse: spy }),
    });
    listingApi.generateListings.mockResolvedValue(batchResp(confirmResponse, [genDraft("item_001", "lamp")]));

    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, ctxArg] = spy.mock.calls[0];
    expect(ctxArg.runId).toBe("run1");
    expect(ctxArg.sourceDeclutter).toBe(result.current.declutter);
    expect(ctxArg.currentConfirmed).toBe(result.current.confirmation);
    expect(ctxArg.currentReviewItems.map((i) => i.item_id)).toEqual(["item_001", "item_002", "item_003"]);
  });

  test("successful batch: ready status, ordered drafts, provenance", async () => {
    const { result } = await primeReady(TWO_SELL);
    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.listingResult.modelName).toBe("phi4-mini");
    expect(result.current.listingResult.maxAttempts).toBe(3);
    expect(result.current.listingDrafts.map((d) => d.item_id)).toEqual(["item_001", "item_003"]);
    expect(result.current.listingDrafts[0].edited_title).toBe("Wooden chair");
    expect(result.current.listingDrafts[0].is_edited).toBe(false);
    expect(result.current.listingDrafts[0].is_discarded).toBe(false);
  });

  test("zero eligible Sell items: a valid ready empty result with no request and null provenance", async () => {
    const KEEP_ONLY = [
      { id: "item_001", ai: "keep", label: "lamp" },
      { id: "item_002", ai: "donate", label: "chair" },
    ];
    const { result, listingApi } = await primeConfirmed(KEEP_ONLY);

    let out;
    await act(async () => {
      out = await result.current.generateListingDrafts();
    });

    expect(listingApi.generateListings).not.toHaveBeenCalled();
    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.listingResult.drafts).toEqual([]);
    expect(result.current.listingDrafts).toEqual([]);
    expect(result.current.listingResult.modelName).toBeNull();
    expect(result.current.listingResult.promptVersion).toBeNull();
    expect(result.current.listingResult.maxAttempts).toBeNull();
    // listingResult is derived from the confirmation and the run's draft
    // cache, so the returned value is structurally, not referentially,
    // the exposed result.
    expect(out).toEqual(result.current.listingResult);
  });

  test("batch failure: error status, but confirmation and Declutter data are preserved", async () => {
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_SELL);
    listingApi.generateListings.mockRejectedValue(new Error("<html>upstream listing failure</html>"));
    const confirmationBefore = result.current.confirmation;
    const declutterBefore = result.current.declutter;

    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(result.current.listingStatus).toBe("error");
    expect(result.current.listingError).toBe("We couldn't generate the listing drafts.");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.confirmation).toBe(confirmationBefore);
    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(result.current.declutter).toBe(declutterBefore);
    expect(result.current.status).toBe("ready");
  });

  test("duplicate batch click while a batch owns the slot is a no-op with no second request", async () => {
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_SELL);
    const d = makeDeferred();
    listingApi.generateListings.mockReturnValueOnce(d.promise);

    let first;
    act(() => {
      first = result.current.generateListingDrafts();
    });
    let second;
    await act(async () => {
      second = await result.current.generateListingDrafts();
    });
    expect(second).toBeNull();
    expect(listingApi.generateListings).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(batchResp(confirmResponse, [genDraft("item_001", "lamp"), genDraft("item_003", "book")]));
      await first;
    });
    expect(result.current.listingStatus).toBe("ready");
  });

  test("regenerateListingDraft calls only the single-item endpoint and replaces only its target", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    const draftsBefore = result.current.listingResult.drafts;
    const item001Before = draftsBefore.find((d) => d.item_id === "item_001");

    listingApi.regenerateListing.mockResolvedValue(
      singleResp(confirmResponse, genDraft("item_003", "book", { title: "Regenerated book", attempts: 2 }))
    );

    await act(async () => {
      await result.current.regenerateListingDraft("item_003");
    });

    expect(listingApi.regenerateListing).toHaveBeenCalledTimes(1);
    expect(listingApi.regenerateListing).toHaveBeenCalledWith({
      runId: "run1",
      analysis: result.current.analysis,
      declutter: result.current.declutter,
      overrides: [],
      itemId: "item_003",
      listingDetails: [{ item_id: "item_003", listing_name: "book", condition: "not_specified" }],
    });
    expect(listingApi.generateListings).toHaveBeenCalledTimes(1); // not called again
    const after = result.current.listingResult.drafts;
    expect(after.find((d) => d.item_id === "item_001")).toBe(item001Before); // same object identity
    expect(after.find((d) => d.item_id === "item_003").title).toBe("Regenerated book");
    expect(result.current.regeneratingItemId).toBeNull();
    expect(result.current.regenerationError).toBeNull();
  });

  test("an initially unavailable draft is regenerable", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL, {
      drafts: [unavailDraft("item_001", "lamp"), genDraft("item_003", "book")],
    });
    expect(result.current.listingDrafts[0].status).toBe("unavailable");

    listingApi.regenerateListing.mockResolvedValue(
      singleResp(confirmResponse, genDraft("item_001", "lamp", { title: "Now available" }))
    );
    await act(async () => {
      await result.current.regenerateListingDraft("item_001");
    });

    expect(result.current.listingDrafts[0].status).toBe("generated");
    expect(result.current.listingDrafts[0].edited_title).toBe("Now available");
  });

  test("a successful regeneration clears only the target's local edit; other edits are preserved", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_001", { title: "My edited lamp title" });
      result.current.editListingDraft("item_003", { title: "My edited book title" });
    });
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_001").is_edited).toBe(true);

    listingApi.regenerateListing.mockResolvedValue(
      singleResp(confirmResponse, genDraft("item_003", "book", { title: "Fresh book" }))
    );
    await act(async () => {
      await result.current.regenerateListingDraft("item_003");
    });

    const d1 = result.current.listingDrafts.find((d) => d.item_id === "item_001");
    const d3 = result.current.listingDrafts.find((d) => d.item_id === "item_003");
    expect(d1.is_edited).toBe(true);
    expect(d1.edited_title).toBe("My edited lamp title");
    expect(d3.is_edited).toBe(false); // edit cleared by the regeneration
    expect(d3.edited_title).toBe("Fresh book");
  });

  test("a failed regeneration keeps the prior draft and edit, and exposes an item-specific error", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_003", { description: "Edited description that is long enough." });
    });
    const draftsBefore = result.current.listingResult.drafts;

    listingApi.regenerateListing.mockRejectedValue(new Error("Traceback: listing_service.py"));
    await act(async () => {
      await result.current.regenerateListingDraft("item_003");
    });

    expect(result.current.listingResult.drafts).toBe(draftsBefore); // untouched
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_003").edited_description).toBe(
      "Edited description that is long enough."
    );
    expect(result.current.regeneratingItemId).toBeNull();
    expect(result.current.regenerationError).toEqual({
      itemId: "item_003",
      message: "We couldn't regenerate that listing draft.",
    });
    expect(result.current.listingStatus).toBe("ready");
  });

  test.each([
    ["modelName", { model_name: "different-model" }],
    ["promptVersion", { prompt_version: "v2" }],
    ["maxAttempts", { max_attempts: 5 }],
  ])(
    "a single-response %s that disagrees with the batch provenance is rejected as contract drift",
    async (_field, over) => {
      const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
      act(() => {
        result.current.editListingDraft("item_001", { title: "My edited lamp" });
      });
      const resultBefore = result.current.listingResult;
      const draftsBefore = result.current.listingResult.drafts;
      const item003Before = draftsBefore.find((d) => d.item_id === "item_003");

      listingApi.regenerateListing.mockResolvedValue(
        singleResp(confirmResponse, genDraft("item_003", "book", { title: "Should not land" }), over)
      );
      let out;
      await act(async () => {
        out = await result.current.regenerateListingDraft("item_003");
      });

      expect(out).toBeNull();
      // batch result, drafts, and every provenance field are the originals
      expect(result.current.listingResult).toBe(resultBefore);
      expect(result.current.listingResult.drafts).toBe(draftsBefore);
      expect(result.current.listingResult.drafts.find((d) => d.item_id === "item_003")).toBe(item003Before);
      expect(result.current.listingResult.modelName).toBe("phi4-mini");
      expect(result.current.listingResult.promptVersion).toBe("v1");
      expect(result.current.listingResult.maxAttempts).toBe(3);
      // local state untouched
      expect(result.current.listingDrafts.find((d) => d.item_id === "item_001").edited_title).toBe("My edited lamp");
      expect(result.current.listingDrafts.find((d) => d.item_id === "item_001").is_edited).toBe(true);
      // item-specific error surfaced, nothing left regenerating
      expect(result.current.regeneratingItemId).toBeNull();
      expect(result.current.regenerationError).toEqual({
        itemId: "item_003",
        message: "Listing draft regeneration returned inconsistent provenance",
      });
      expect(result.current.listingStatus).toBe("ready");
    }
  );

  test("provenance-drift rejection prevents the maxAttempts/attempts inconsistency a naive merge would produce", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    expect(result.current.listingResult.maxAttempts).toBe(3);

    // The single response is self-consistent (attempts 4 <= its own
    // max_attempts 5) but its max_attempts differs from the batch's 3.
    // Merging its draft while keeping the batch max_attempts=3 would
    // leave a draft claiming attempts=4 under a recorded ceiling of 3.
    listingApi.regenerateListing.mockResolvedValue(
      singleResp(confirmResponse, genDraft("item_003", "book", { attempts: 4 }), { max_attempts: 5 })
    );
    await act(async () => {
      await result.current.regenerateListingDraft("item_003");
    });

    // Rejected: no draft merged, ceiling still 3, and no draft exceeds it.
    expect(result.current.listingResult.maxAttempts).toBe(3);
    const merged = result.current.listingResult.drafts.find((d) => d.item_id === "item_003");
    expect(merged.attempts).toBe(1); // still the original batch draft
    expect(result.current.listingResult.drafts.every((d) => d.attempts <= result.current.listingResult.maxAttempts)).toBe(
      true
    );
    expect(result.current.regenerationError.itemId).toBe("item_003");
  });

  test("duplicate regeneration click is a no-op with no second request", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    const d = makeDeferred();
    listingApi.regenerateListing.mockReturnValueOnce(d.promise);

    let first;
    act(() => {
      first = result.current.regenerateListingDraft("item_003");
    });
    let second;
    act(() => {
      second = result.current.regenerateListingDraft("item_003");
    });
    expect(listingApi.regenerateListing).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(singleResp(confirmResponse, genDraft("item_003", "book")));
      await Promise.all([first, second]);
    });
    expect(result.current.regeneratingItemId).toBeNull();
  });

  test("regenerateListingDraft throws synchronously for a non-eligible / unknown / pre-batch target, without a request", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    expect(() => result.current.regenerateListingDraft("item_999")).toThrow(/not a currently eligible/);
    expect(() => result.current.regenerateListingDraft("item_002")).toThrow(/not a currently eligible/); // Keep item
    expect(listingApi.regenerateListing).not.toHaveBeenCalled();

    const { result: r2 } = await primeConfirmed(TWO_SELL); // ready never reached
    expect(() => r2.current.regenerateListingDraft("item_001")).toThrow(/no current listing result/);
  });

  test("editing is local, tracks the server baseline, is never trimmed, and never calls the backend", async () => {
    const { result } = await primeReady(TWO_SELL);

    act(() => {
      result.current.editListingDraft("item_001", { title: "Brand new title" });
    });
    let d1 = result.current.listingDrafts.find((d) => d.item_id === "item_001");
    expect(d1.title).toBe("Wooden chair"); // server value untouched
    expect(d1.edited_title).toBe("Brand new title");
    expect(d1.is_edited).toBe(true);

    act(() => {
      result.current.editListingDraft("item_001", { title: "Wooden chair" }); // back to baseline
    });
    d1 = result.current.listingDrafts.find((d) => d.item_id === "item_001");
    expect(d1.is_edited).toBe(false);

    act(() => {
      result.current.editListingDraft("item_001", { title: "   spaced   " });
    });
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_001").edited_title).toBe("   spaced   ");

    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1);
    expect(client.overrideItem).not.toHaveBeenCalled();
  });

  test("editListingDraft rejects an unavailable / unknown target and a non-string value synchronously", async () => {
    const { result } = await primeReady(TWO_SELL, {
      drafts: [unavailDraft("item_001", "lamp"), genDraft("item_003", "book")],
    });
    expect(() => result.current.editListingDraft("item_001", { title: "x" })).toThrow(/no draft text to edit/);
    expect(() => result.current.editListingDraft("item_999", { title: "x" })).toThrow(/not a current listing draft/);
    expect(() => result.current.editListingDraft("item_003", { title: 42 })).toThrow(/must be a string/);
  });

  test("discard is local presentation state only; restore reverses only that", async () => {
    const { result } = await primeReady(TWO_SELL);
    const confirmationBefore = result.current.confirmation;
    const overridesBefore = result.current.overridesById;

    act(() => {
      result.current.discardListingDraft("item_001");
    });
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_001").is_discarded).toBe(true);
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_003").is_discarded).toBe(false);
    expect(result.current.confirmation).toBe(confirmationBefore);
    expect(result.current.overridesById).toBe(overridesBefore);
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1); // no extra backend call

    act(() => {
      result.current.restoreListingDraft("item_001");
    });
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_001").is_discarded).toBe(false);
  });

  test.each([
    ["a new upload", async (r) => { client.uploadImage.mockResolvedValue(listUpload(TWO_SELL)); await r.current.submit({ file: makeFile(), context: null }); }],
    ["a decision override change", (r) => r.current.setDecisionOverride("item_001", "keep")],
    ["an exclusion change", (r) => r.current.setItemExcluded("item_001", true)],
    ["full reset", (r) => r.current.reset()],
  ])("listing state is invalidated by %s", async (_label, trigger) => {
    const { result } = await primeReady(TWO_SELL);
    expect(result.current.listingStatus).toBe("ready");

    await act(async () => {
      await trigger(result);
    });

    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.listingDrafts).toEqual([]);
    expect(result.current.regenerationError).toBeNull();
  });

  test("clearing a decision override invalidates listing state", async () => {
    const { result } = await primeReady(TWO_SELL, {
      beforeConfirm: (r) => r.current.setDecisionOverride("item_001", "sell"),
      // spec already has item_001 ai:sell, so this override is a redundant restate; it still exists in overridesById
    });
    // re-confirm + re-batch so there IS a ready result AND an override to clear
    expect(result.current.overridesById.item_001).toBeTruthy();

    await act(async () => {
      result.current.clearDecisionOverride("item_001");
    });
    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
  });

  test("a label correction that actually starts invalidates listing state", async () => {
    const { result } = await primeReady(TWO_SELL);
    const d = makeDeferred();
    client.overrideItem.mockReturnValueOnce(d.promise);

    act(() => {
      result.current.correctLabel("item_001", "table lamp");
    });
    // invalidated the moment the correction starts, before it resolves
    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();

    await act(async () => {
      d.reject(new Error("correction failed"));
      await Promise.resolve();
    });
  });

  test("a synchronously-rejected edit action does NOT invalidate listing state first", async () => {
    const { result } = await primeReady(TWO_SELL);

    expect(() => result.current.setDecisionOverride("item_999", "keep")).toThrow();
    expect(() => result.current.correctLabel("item_999", "x")).toThrow();

    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.listingResult).not.toBeNull();
  });

  test("a stale batch success is discarded after an invalidation", async () => {
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_SELL);
    const d = makeDeferred();
    listingApi.generateListings.mockReturnValueOnce(d.promise);

    let p;
    act(() => {
      p = result.current.generateListingDrafts();
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "keep"); // invalidates listing mid-flight
    });
    await act(async () => {
      d.resolve(batchResp(confirmResponse, [genDraft("item_001", "lamp"), genDraft("item_003", "book")]));
      await p;
    });

    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.listingError).toBeNull();
  });

  test("a stale batch failure is discarded after an invalidation", async () => {
    const { result, listingApi } = await primeConfirmed(TWO_SELL);
    const d = makeDeferred();
    listingApi.generateListings.mockReturnValueOnce(d.promise);

    let p;
    act(() => {
      p = result.current.generateListingDrafts();
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      d.reject(new Error("too late"));
      await p;
    });

    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingError).toBeNull();
  });

  test("a stale regeneration SUCCESS makes no state changes", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    const okD = makeDeferred();
    listingApi.regenerateListing.mockReturnValueOnce(okD.promise);

    let p1;
    act(() => {
      p1 = result.current.regenerateListingDraft("item_003");
    });
    act(() => {
      result.current.setDecisionOverride("item_001", "keep"); // invalidate mid-regen
    });
    let out;
    await act(async () => {
      okD.resolve(singleResp(confirmResponse, genDraft("item_003", "book", { title: "stale" })));
      out = await p1;
    });
    expect(out).toBeNull();
    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.regeneratingItemId).toBeNull();
    expect(result.current.regenerationError).toBeNull();
  });

  test("a stale regeneration REJECTION makes no state changes", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    const badD = makeDeferred();
    listingApi.regenerateListing.mockReturnValueOnce(badD.promise);

    let p1;
    act(() => {
      p1 = result.current.regenerateListingDraft("item_003");
    });
    expect(result.current.regeneratingItemId).toBe("item_003");

    act(() => {
      result.current.setDecisionOverride("item_001", "keep"); // invalidate mid-regen
    });
    // post-invalidation snapshot
    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.regeneratingItemId).toBeNull();

    let out;
    await act(async () => {
      badD.reject(new Error("regen rejected after invalidation"));
      out = await p1;
    });

    expect(out).toBeNull();
    expect(result.current.regenerationError).toBeNull(); // NOT set by the stale rejection
    expect(result.current.listingResult).toBeNull(); // NOT restored
    expect(result.current.listingStatus).toBe("idle"); // unchanged
    expect(result.current.regeneratingItemId).toBeNull();
    expect(result.current.listingError).toBeNull();
  });

  test("reset while a batch is in flight resets everything", async () => {
    const { result, listingApi } = await primeConfirmed(TWO_SELL);
    const d = makeDeferred();
    listingApi.generateListings.mockReturnValueOnce(d.promise);

    let p;
    act(() => {
      p = result.current.generateListingDrafts();
    });
    expect(result.current.listingStatus).toBe("generating");

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      d.resolve(batchResp(listConfirmResponse(TWO_SELL), [genDraft("item_001", "lamp"), genDraft("item_003", "book")]));
      await p;
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingResult).toBeNull();
    expect(result.current.confirmation).toBeNull();
  });

  test("listing operations never touch upload / confirmation status or errors", async () => {
    const { result, listingApi } = await primeConfirmed(TWO_SELL);
    listingApi.generateListings.mockRejectedValue(new Error("listing down"));

    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(result.current.status).toBe("ready"); // upload domain untouched
    expect(result.current.error).toBeNull();
    expect(result.current.confirmationStatus).toBe("confirmed"); // confirmation domain untouched
    expect(result.current.confirmationError).toBeNull();
  });

  test("existing upload / confirmation behaviour is unchanged when listing is never used", async () => {
    client.uploadImage.mockResolvedValue(listUpload(TWO_SELL));
    client.confirmDecisions.mockResolvedValue(listConfirmResponse(TWO_SELL));
    const { result } = renderHook(() => useDeclutterFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(result.current.confirmation.confirmedKeepIds).toEqual(["item_002"]);
    // the default listing seam exists and is inert
    expect(result.current.listingStatus).toBe("idle");
    expect(typeof result.current.generateListingDrafts).toBe("function");
  });
});

describe("useDeclutterFlow, seller-supplied listing details", () => {
  const TWO_LAMPS = [
    { id: "item_001", ai: "sell", label: "lamp" },
    { id: "item_002", ai: "keep", label: "chair" },
    { id: "item_003", ai: "sell", label: "lamp" },
  ];

  test("details set before the first draft are sent per item_id, independently, even when labels repeat", async () => {
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_LAMPS);
    act(() => {
      result.current.setListingDetails("item_003", { listing_name: "Brass reading lamp" });
      result.current.setListingDetails("item_003", { condition: "good" });
    });
    listingApi.generateListings.mockResolvedValue(
      batchResp(confirmResponse, [genDraft("item_001", "lamp"), genDraft("item_003", "lamp")])
    );

    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(listingApi.generateListings.mock.calls[0][0].listingDetails).toEqual([
      { item_id: "item_001", listing_name: "lamp", condition: "not_specified" },
      { item_id: "item_003", listing_name: "Brass reading lamp", condition: "good" },
    ]);
    const [first, second] = result.current.listingDrafts;
    expect(first.listing_name).toBe("lamp");
    expect(first.condition).toBe("not_specified");
    expect(second.listing_name).toBe("Brass reading lamp");
    expect(second.condition).toBe("good");
    expect(first.is_stale).toBe(false);
    expect(second.is_stale).toBe(false);
    // Listing metadata never touches the reviewed label or the decision.
    expect(result.current.reviewItems.find((i) => i.item_id === "item_003").effective_label).toBe("lamp");
    expect(result.current.confirmationStatus).toBe("confirmed");
  });

  test("changing details after a draft never rewrites its text; it only marks that draft stale", async () => {
    const { result } = await primeReady(TWO_SELL);
    const before = result.current.listingDrafts.map((d) => [d.item_id, d.edited_title, d.edited_description]);

    act(() => {
      result.current.setListingDetails("item_003", { condition: "fair" });
    });

    const after = result.current.listingDrafts;
    expect(after.map((d) => [d.item_id, d.edited_title, d.edited_description])).toEqual(before);
    expect(after.find((d) => d.item_id === "item_003").is_stale).toBe(true);
    expect(after.find((d) => d.item_id === "item_001").is_stale).toBe(false);
    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.confirmationStatus).toBe("confirmed");

    // Setting the details back to what the draft was made with clears the flag.
    act(() => {
      result.current.setListingDetails("item_003", { condition: "not_specified" });
    });
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_003").is_stale).toBe(false);
  });

  test("an explicit regeneration sends only the target's latest details and clears its stale flag", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    act(() => {
      result.current.setListingDetails("item_001", { listing_name: "Desk lamp", condition: "new" });
      result.current.setListingDetails("item_003", { listing_name: "Paperback novel", condition: "well_used" });
    });
    expect(result.current.listingDrafts.every((d) => d.is_stale)).toBe(true);

    listingApi.regenerateListing.mockResolvedValue(
      singleResp(confirmResponse, genDraft("item_003", "book", { title: "Paperback novel" }))
    );

    await act(async () => {
      await result.current.regenerateListingDraft("item_003");
    });

    expect(listingApi.regenerateListing.mock.calls[0][0].listingDetails).toEqual([
      { item_id: "item_003", listing_name: "Paperback novel", condition: "well_used" },
    ]);
    const drafts = result.current.listingDrafts;
    expect(drafts.find((d) => d.item_id === "item_003").is_stale).toBe(false);
    expect(drafts.find((d) => d.item_id === "item_003").title).toBe("Paperback novel");
    // The other item stays stale until it is regenerated itself.
    expect(drafts.find((d) => d.item_id === "item_001").is_stale).toBe(true);
  });

  test("a blank listing name is sent as null so the server falls back to the detected label", async () => {
    const { result, listingApi, confirmResponse } = await primeConfirmed(TWO_SELL);
    act(() => {
      result.current.setListingDetails("item_001", { listing_name: "   " });
    });
    listingApi.generateListings.mockResolvedValue(
      batchResp(confirmResponse, [genDraft("item_001", "lamp"), genDraft("item_003", "book")])
    );
    await act(async () => {
      await result.current.generateListingDrafts();
    });
    expect(listingApi.generateListings.mock.calls[0][0].listingDetails[0]).toEqual({
      item_id: "item_001",
      listing_name: null,
      condition: "not_specified",
    });
  });

  test("setListingDetails rejects bad input synchronously and changes nothing", async () => {
    const { result } = await primeConfirmed(TWO_SELL);
    expect(() => result.current.setListingDetails("", { condition: "good" })).toThrow();
    expect(() => result.current.setListingDetails("item_001", { condition: "mint" })).toThrow();
    expect(() => result.current.setListingDetails("item_001", { listing_name: 5 })).toThrow();
    expect(() => result.current.setListingDetails("item_001", {})).toThrow();
    expect(() => result.current.setListingDetails("item_001", { price: 10 })).toThrow();
    expect(result.current.listingDetailsById).toEqual({});
  });

  test("details survive a confirmation invalidation (no drafts are active without a confirmation); reset clears details", async () => {
    const { result } = await primeReady(TWO_SELL);
    act(() => {
      result.current.setListingDetails("item_001", { listing_name: "Desk lamp", condition: "good" });
    });

    act(() => {
      result.current.setDecisionOverride("item_002", "donate");
    });
    expect(result.current.confirmationStatus).toBe("idle");
    expect(result.current.listingDrafts).toEqual([]);
    expect(result.current.listingDetailsById).toEqual({ item_001: { listing_name: "Desk lamp", condition: "good" } });

    act(() => {
      result.current.reset();
    });
    expect(result.current.listingDetailsById).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Draft reconciliation across confirmations, and one user-facing name per item
// ---------------------------------------------------------------------------

// A full /override response for a multi-item run: the whole analysis and
// declutter, with one item's label corrected and its AI decision rerun.
function correctedOverrideResp(specs, itemId, label, decision) {
  const upload = listUpload(specs);
  return {
    run_id: upload.run_id,
    analysis: {
      ...upload.analysis,
      items: upload.analysis.items.map((item) =>
        item.item_id === itemId ? { ...item, corrected_label: label, label_source: "user", effective_label: label } : item
      ),
    },
    declutter: {
      ...upload.declutter,
      ai_decisions: upload.declutter.ai_decisions.map((d) =>
        d.item_id === itemId ? { ...d, decision: decision ?? d.decision } : d
      ),
    },
  };
}

async function reconfirmAs(result, specs) {
  client.confirmDecisions.mockResolvedValue(listConfirmResponse(specs));
  await act(async () => {
    await result.current.confirm();
  });
}

describe("useDeclutterFlow, listing drafts reconcile by item_id across confirmations", () => {
  test("re-confirming unchanged decisions shows the same drafts at once, with edits, discards and details, and no request", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_001", { title: "My lamp title" });
      result.current.discardListingDraft("item_003");
      result.current.setListingDetails("item_001", { condition: "good" });
    });
    const draftBefore = result.current.listingResult.drafts[0];

    await reconfirmAs(result, TWO_SELL);

    expect(result.current.listingStatus).toBe("ready");
    expect(listingApi.generateListings).toHaveBeenCalledTimes(1); // the original batch only
    expect(listingApi.regenerateListing).not.toHaveBeenCalled();
    const drafts = result.current.listingDrafts;
    expect(drafts.map((d) => d.item_id)).toEqual(["item_001", "item_003"]);
    expect(drafts[0].edited_title).toBe("My lamp title");
    expect(drafts[0].condition).toBe("good");
    expect(drafts[1].is_discarded).toBe(true);
    expect(result.current.listingResult.drafts[0]).toBe(draftBefore);
    expect(result.current.missingListingItemIds).toEqual([]);
  });

  test("a newly confirmed Sell item is drafted on its own: one single-item request, existing drafts untouched", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_003", { description: "My own description of the book." });
    });

    act(() => {
      result.current.setDecisionOverride("item_002", "sell");
    });
    const NOW_THREE_SELL = [
      { id: "item_001", ai: "sell", label: "lamp" },
      { id: "item_002", ai: "keep", decision: "sell", label: "chair" },
      { id: "item_003", ai: "sell", label: "book" },
    ];
    await reconfirmAs(result, NOW_THREE_SELL);

    // Existing drafts are back immediately; the new item is listed as missing.
    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.listingDrafts.map((d) => d.item_id)).toEqual(["item_001", "item_003"]);
    expect(result.current.missingListingItemIds).toEqual(["item_002"]);

    const confirmResponse = listConfirmResponse(NOW_THREE_SELL);
    listingApi.regenerateListing.mockResolvedValue(singleResp(confirmResponse, genDraft("item_002", "chair", { title: "Oak chair" })));
    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(listingApi.generateListings).toHaveBeenCalledTimes(1); // still only the first batch
    expect(listingApi.regenerateListing).toHaveBeenCalledTimes(1);
    expect(listingApi.regenerateListing.mock.calls[0][0].itemId).toBe("item_002");
    expect(listingApi.regenerateListing.mock.calls[0][0].listingDetails).toEqual([
      { item_id: "item_002", listing_name: "chair", condition: "not_specified" },
    ]);
    const drafts = result.current.listingDrafts;
    expect(drafts.map((d) => d.item_id)).toEqual(["item_001", "item_002", "item_003"]);
    expect(drafts.find((d) => d.item_id === "item_002").title).toBe("Oak chair");
    expect(drafts.find((d) => d.item_id === "item_003").edited_description).toBe("My own description of the book.");
    expect(result.current.missingListingItemIds).toEqual([]);
    expect(result.current.regeneratingItemId).toBeNull();
  });

  test("a failed new-item listing request never exposes its raw error", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    act(() => {
      result.current.setDecisionOverride("item_002", "sell");
    });
    const NOW_THREE_SELL = [
      { id: "item_001", ai: "sell", label: "lamp" },
      { id: "item_002", ai: "keep", decision: "sell", label: "chair" },
      { id: "item_003", ai: "sell", label: "book" },
    ];
    await reconfirmAs(result, NOW_THREE_SELL);
    listingApi.regenerateListing.mockRejectedValue(new Error("<html>upstream stack trace</html>"));

    await act(async () => {
      await result.current.generateListingDrafts();
    });

    expect(result.current.listingError).toBe("We couldn't generate the listing drafts.");
    expect(result.current.listingError).not.toMatch(/html|stack trace/i);
    expect(result.current.listingDrafts.map((draft) => draft.item_id)).toEqual(["item_001", "item_003"]);
    expect(result.current.missingListingItemIds).toEqual(["item_002"]);
    expect(result.current.regeneratingItemId).toBeNull();
  });

  test("an item that stops being Sell leaves the active listings and cannot be edited or regenerated; its draft returns if it is Sell again", async () => {
    const { result } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_003", { title: "Kept book title" });
    });

    act(() => {
      result.current.setDecisionOverride("item_003", "keep");
    });
    const BOOK_KEPT = [
      { id: "item_001", ai: "sell", label: "lamp" },
      { id: "item_002", ai: "keep", label: "chair" },
      { id: "item_003", ai: "sell", decision: "keep", label: "book" },
    ];
    await reconfirmAs(result, BOOK_KEPT);

    expect(result.current.listingDrafts.map((d) => d.item_id)).toEqual(["item_001"]);
    expect(result.current.listingResult.eligibleItemIds).toEqual(["item_001"]);
    expect(() => result.current.regenerateListingDraft("item_003")).toThrow();
    expect(() => result.current.editListingDraft("item_003", { title: "x" })).toThrow();
    expect(() => result.current.discardListingDraft("item_003")).toThrow();

    act(() => {
      result.current.setDecisionOverride("item_003", "sell");
    });
    await reconfirmAs(result, TWO_SELL);
    const book = result.current.listingDrafts.find((d) => d.item_id === "item_003");
    expect(book.edited_title).toBe("Kept book title");
    expect(result.current.missingListingItemIds).toEqual([]);
  });

  test("a Decide-items label correction keeps the draft text, marks it older, and single-item regeneration updates it", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    client.overrideItem.mockResolvedValue(correctedOverrideResp(TWO_SELL, "item_001", "desk lamp"));
    await act(async () => {
      await result.current.correctLabel("item_001", "desk lamp");
    });
    expect(result.current.confirmationStatus).toBe("idle"); // the correction reran reasoning
    await reconfirmAs(result, TWO_SELL);

    const lamp = result.current.listingDrafts.find((d) => d.item_id === "item_001");
    expect(lamp.title).toBe("Wooden chair"); // the old draft text, untouched
    expect(lamp.effective_label).toBe("desk lamp");
    expect(lamp.generated_with.label).toBe("lamp");
    expect(lamp.is_stale).toBe(true);
    expect(listingApi.regenerateListing).not.toHaveBeenCalled();

    listingApi.regenerateListing.mockResolvedValue(
      singleResp(listConfirmResponse(TWO_SELL), genDraft("item_001", "desk lamp", { title: "Desk lamp" }))
    );
    await act(async () => {
      await result.current.regenerateListingDraft("item_001");
    });
    const refreshed = result.current.listingDrafts.find((d) => d.item_id === "item_001");
    expect(refreshed.title).toBe("Desk lamp");
    expect(refreshed.is_stale).toBe(false);
  });

  test("a stale single-item response after a decision change never restores or overwrites a draft", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    const d = makeDeferred();
    listingApi.regenerateListing.mockReturnValueOnce(d.promise);
    let p;
    act(() => {
      p = result.current.regenerateListingDraft("item_003");
    });
    act(() => {
      result.current.setDecisionOverride("item_002", "donate"); // confirmation gone mid-flight
    });
    await act(async () => {
      d.resolve(singleResp(listConfirmResponse(TWO_SELL), genDraft("item_003", "book", { title: "LATE" })));
      await p;
    });

    await reconfirmAs(result, TWO_SELL);
    const book = result.current.listingDrafts.find((dr) => dr.item_id === "item_003");
    expect(book.title).toBe("Wooden chair"); // the pre-regeneration draft, not the late one
    expect(result.current.regenerationError).toBeNull();
  });

  test("a stale new-item generation after a decision change writes nothing", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    act(() => {
      result.current.setDecisionOverride("item_002", "sell");
    });
    const NOW_THREE_SELL = [
      { id: "item_001", ai: "sell", label: "lamp" },
      { id: "item_002", ai: "keep", decision: "sell", label: "chair" },
      { id: "item_003", ai: "sell", label: "book" },
    ];
    await reconfirmAs(result, NOW_THREE_SELL);
    const d = makeDeferred();
    listingApi.regenerateListing.mockReturnValueOnce(d.promise);
    let p;
    act(() => {
      p = result.current.generateListingDrafts();
    });
    expect(result.current.regeneratingItemId).toBe("item_002");
    act(() => {
      result.current.setDecisionOverride("item_002", "keep");
    });
    await act(async () => {
      d.resolve(singleResp(listConfirmResponse(NOW_THREE_SELL), genDraft("item_002", "chair")));
      await p;
    });

    // Sell again later: the chair has NO draft, because the late response was dropped.
    act(() => {
      result.current.setDecisionOverride("item_002", "sell");
    });
    await reconfirmAs(result, NOW_THREE_SELL);
    expect(result.current.missingListingItemIds).toEqual(["item_002"]);
    expect(result.current.listingError).toBeNull();
  });

  test("an edit made while a regeneration is in flight is kept, not overwritten by the response", async () => {
    const { result, listingApi, confirmResponse } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_001", { title: "First edit" });
    });
    const d = makeDeferred();
    listingApi.regenerateListing.mockReturnValueOnce(d.promise);
    let p;
    act(() => {
      p = result.current.regenerateListingDraft("item_001");
    });
    act(() => {
      result.current.editListingDraft("item_001", { title: "Newer edit during regeneration" });
    });
    await act(async () => {
      d.resolve(singleResp(confirmResponse, genDraft("item_001", "lamp", { title: "Regenerated" })));
      await p;
    });
    const lamp = result.current.listingDrafts.find((dr) => dr.item_id === "item_001");
    expect(lamp.title).toBe("Regenerated");
    expect(lamp.edited_title).toBe("Newer edit during regeneration");
  });

  test("a new photo clears every cached draft, edit, discard and name", async () => {
    const { result, listingApi } = await primeReady(TWO_SELL);
    act(() => {
      result.current.editListingDraft("item_001", { title: "Edited" });
      result.current.setListingDetails("item_001", { listing_name: "Brass lamp" });
    });
    client.uploadImage.mockResolvedValue(listUpload(TWO_SELL, "run1"));
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    await reconfirmAs(result, TWO_SELL);

    expect(result.current.listingStatus).toBe("idle");
    expect(result.current.listingDrafts).toEqual([]);
    expect(result.current.missingListingItemIds).toEqual(["item_001", "item_003"]);
    expect(result.current.listingEditsById).toEqual({});
    expect(result.current.listingDetailsById).toEqual({});
    expect(result.current.reviewItems.find((i) => i.item_id === "item_001").display_label).toBe("lamp");
    expect(listingApi.generateListings).toHaveBeenCalledTimes(1);
  });
});

describe("useDeclutterFlow, one user-facing name per item_id", () => {
  const TWO_LAMPS = [
    { id: "item_001", ai: "sell", label: "lamp" },
    { id: "item_002", ai: "keep", label: "chair" },
    { id: "item_003", ai: "sell", label: "lamp" },
  ];

  test("a listing rename becomes the review item's display_label without an override call or a decision change", async () => {
    const { result } = await primeReady(TWO_LAMPS);
    const confirmationBefore = result.current.confirmation;
    act(() => {
      result.current.setListingDetails("item_003", { listing_name: "Brass reading lamp" });
    });

    const byId = Object.fromEntries(result.current.reviewItems.map((i) => [i.item_id, i]));
    // Duplicate labels stay distinct by item_id.
    expect(byId.item_001.display_label).toBe("lamp");
    expect(byId.item_003.display_label).toBe("Brass reading lamp");
    // Provenance: reasoning and detector labels are unchanged.
    expect(byId.item_003.effective_label).toBe("lamp");
    expect(byId.item_003.clean_label).toBe("lamp");
    expect(client.overrideItem).not.toHaveBeenCalled();
    expect(result.current.confirmation).toBe(confirmationBefore);
    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(result.current.overridesById).toEqual({});
    // The draft is flagged, not rewritten.
    expect(result.current.listingDrafts.find((d) => d.item_id === "item_003").is_stale).toBe(true);
  });

  test("a blank rename falls back to the reasoning label as the display name", async () => {
    const { result } = await primeReady(TWO_LAMPS);
    act(() => {
      result.current.setListingDetails("item_001", { listing_name: "   " });
    });
    expect(result.current.reviewItems.find((i) => i.item_id === "item_001").display_label).toBe("lamp");
  });

  test("a later Decide-items correction replaces the listing name, so both screens show the corrected label", async () => {
    const { result } = await primeReady(TWO_LAMPS);
    act(() => {
      result.current.setListingDetails("item_001", { listing_name: "Brass lamp", condition: "fair" });
    });
    client.overrideItem.mockResolvedValue(correctedOverrideResp(TWO_LAMPS, "item_001", "desk lamp"));
    await act(async () => {
      await result.current.correctLabel("item_001", "desk lamp");
    });

    const lamp = result.current.reviewItems.find((i) => i.item_id === "item_001");
    expect(lamp.display_label).toBe("desk lamp");
    expect(lamp.effective_label).toBe("desk lamp");
    // Only the name override is dropped; the condition is kept.
    expect(result.current.listingDetailsById.item_001).toEqual({ condition: "fair" });
    // The other lamp is untouched.
    expect(result.current.reviewItems.find((i) => i.item_id === "item_003").display_label).toBe("lamp");
  });

  test("a failed correction keeps the listing name", async () => {
    const { result } = await primeReady(TWO_LAMPS);
    act(() => {
      result.current.setListingDetails("item_001", { listing_name: "Brass lamp" });
    });
    client.overrideItem.mockRejectedValue(new Error("service unavailable"));
    await act(async () => {
      await result.current.correctLabel("item_001", "desk lamp");
    });
    expect(result.current.reviewItems.find((i) => i.item_id === "item_001").display_label).toBe("Brass lamp");
  });
});
