import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useDeclutterFlow } from "./useDeclutterFlow";
import * as client from "../api/client";

// Only the frontend API functions are mocked — normaliseDeclutterUploadResponse/
// normaliseConfirmationResponse (the pure contract adapters) run for real, so
// these tests also prove the hook wires real, validating adapters correctly,
// not just that it calls the right mocked functions.
vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
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
    client.uploadImage.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useDeclutterFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("network down");
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

    // Set item_002's override first, item_001's second — proves
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
    client.confirmDecisions.mockRejectedValue(new Error("service unavailable"));
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
    expect(result.current.confirmationError).toBe("service unavailable");
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

    // Edit while the request is outstanding — must invalidate its generation.
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

    // Resolve the OLDER request now — it must not clobber the newer state.
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
    client.overrideItem.mockRejectedValue(new Error("service unavailable"));
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
    expect(result.current.correctionError).toEqual({ itemId: "item_001", message: "service unavailable" });
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
    // The blocked call is state-neutral — it must not leave a fake
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
    // invalidate the correction itself — this is the regression this
    // task fixes: it used to make the correction's own response look
    // stale, leaving correctingItemId stuck non-null forever.
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    expect(result.current.overridesById.item_001.decision).toBe("donate");

    await act(async () => {
      deferred.resolve(makeOverrideResponse({ decision: "sell" }));
    });

    // The correction was NOT discarded as stale — it fully applied.
    expect(result.current.correctingItemId).toBeNull();
    expect(result.current.items[0].effective_label).toBe("hoodie");
    expect(result.current.declutter.ai_decisions[0].decision).toBe("sell");
    // The user's own decision override survives the correction.
    expect(result.current.overridesById.item_001.decision).toBe("donate");
    expect(result.current.reviewItems[0].review_decision).toBe("donate");
    // Confirmation remains invalidated (the edit also invalidated it,
    // redundantly with the correction — either way it must stay cleared).
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

    expect(result.current.correctingItemId).toBeNull(); // not stuck — the correction was not discarded as stale
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
