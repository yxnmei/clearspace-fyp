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
});
