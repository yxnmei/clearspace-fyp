import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useBothFlow } from "./useBothFlow";
import * as client from "../api/client";
// Real listing normalisers, injected through the listingApi seam (Stage 3).
import { normaliseListingResponse, normaliseSingleListingResponse } from "../api/listingContract";

// Only the frontend API functions are mocked, the real, validating
// declutterContract/confirmationContract/reorganiseContract adapters run
// for real, so these tests also prove the hook wires real contract
// validation correctly, matching useDeclutterFlow.test.jsx's and
// useReorganiseFlow.test.jsx's own established convention.
vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
  generateConfirmedReorganisation: vi.fn(),
  // Present so the composed useDeclutterFlow's `import { generateListings,
  // regenerateListing }` resolves; listing tests inject their own
  // `listingApi` seam via useBothFlow({ listingApi }).
  generateListings: vi.fn(),
  regenerateListing: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeFile(name = "room.png", type = "image/png") {
  return new File(["fake bytes"], name, { type });
}

const HASH = "a".repeat(64);

function makeItem(overrides = {}) {
  return {
    item_id: "item_001",
    source_detection_index: 0,
    raw_phrase: "lamp",
    clean_label: "lamp",
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    confidence: 0.8,
    position: "upper-left",
    relative_size: "small",
    item_role: "actionable",
    item_role_source: "default",
    corrected_label: null,
    label_source: "detector",
    effective_label: "lamp",
    ...overrides,
  };
}

// decisions: [{ itemId, decision }]
function makeBothUploadResponse({ runId = "run1", decisions = [{ itemId: "item_001", decision: "keep" }] } = {}) {
  const items = decisions.map((d, i) =>
    makeItem({ item_id: d.itemId, source_detection_index: i, clean_label: d.label ?? "lamp", effective_label: d.label ?? "lamp" })
  );
  return {
    run_id: runId,
    path: "both",
    analysis: {
      run_id: runId,
      scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
      items,
      warnings: [],
      stage_timings: [],
    },
    declutter: {
      run_id: runId,
      expected_item_ids: decisions.map((d) => d.itemId),
      ai_decisions: decisions.map((d) => ({ item_id: d.itemId, decision: d.decision, reason: `reason for ${d.itemId}` })),
      unresolved_item_ids: [],
      item_validity: Object.fromEntries(decisions.map((d) => [d.itemId, "raw_valid"])),
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
    input_image_sha256: HASH,
  };
}

// confirmed: [{ itemId, aiDecision, confirmedDecision, excluded }]
function makeConfirmResponse(runId, confirmed) {
  const confirmed_decisions = confirmed.map((d) => ({
    item_id: d.itemId,
    ai_decision: d.aiDecision,
    confirmed_decision: d.confirmedDecision,
    ai_reason: `reason for ${d.itemId}`,
    user_reason: null,
    excluded: Boolean(d.excluded),
    decision_changed: d.aiDecision !== d.confirmedDecision,
  }));
  const confirmed_keep_ids = confirmed_decisions
    .filter((d) => d.confirmed_decision === "keep" && !d.excluded)
    .map((d) => d.item_id);
  return {
    run_id: runId,
    confirmed_decisions,
    confirmed_keep_ids,
    decision_changed_count: confirmed_decisions.filter((d) => d.decision_changed).length,
    excluded_count: confirmed_decisions.filter((d) => d.excluded).length,
  };
}

function makeGenerationBody(runId, itemIds) {
  return {
    tidy_plan: { phases: [{ phase_id: "empty_clean", title: "Empty and clean", steps: [{ step_id: "empty_clean-1", text: "Clear the main surface.", item_ids: itemIds.slice(0, 1) }] }] },
    action_plan: {
      run_id: runId,
      actions: [{ priority: 1, title: "Clear the desk", instruction: "Straighten the lamp and clear the space around it." }],
      provenance: "llm_generated",
      attempts: 1,
      model_name: "phi4-mini",
      prompt_version: "reorganise-actions-v1",
      was_repaired: false,
      duration_ms: 5,
      issues: [],
    },
    focus_areas: [{ area_id: "left", label: "Left side", item_ids: itemIds }],
    storage_suggestions: [],
    image_prompt: "a tidy bedroom",
  };
}

function makeGeneratedImage(overrides = {}) {
  return {
    image: "aGVsbG8=",
    image_media_type: "image/png",
    api_version: "v1",
    depth_map_used: true,
    denoise_strength: 0.35,
    controlnet_conditioning_scale: 1.0,
    seed: 42,
    base_model: "runwayml/stable-diffusion-v1-5",
    controlnet_model: "lllyasviel/sd-controlnet-depth",
    service_version: "colab-dev-0.1",
    generation_ms: 100,
    prompt_sha256: "b".repeat(64),
    input_image_sha256: HASH,
    ...overrides,
  };
}

// Builds a /generate/confirmed response whose `confirmation` is the exact
// ConfirmationResult a matching makeConfirmResponse() call would produce
// i.e. genuinely server-derived and internally consistent, not a
// client echo, and whose focus areas cover exactly confirmedKeepIds.
function makeConfirmedGenerateResponse(runId, confirmed, { imageStatus = "generated", unavailableReason = null } = {}) {
  const confirmation = makeConfirmResponse(runId, confirmed);
  return {
    run_id: runId,
    confirmation,
    ...makeGenerationBody(runId, confirmation.confirmed_keep_ids),
    image_status: imageStatus,
    image: imageStatus === "generated" ? makeGeneratedImage() : null,
    image_unavailable_reason: imageStatus === "generated" ? null : unavailableReason,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drives a hook instance through upload -> confirm (single item, Keep),
// the common starting point for most tests below.
async function confirmedFlow({ decisions = [{ itemId: "item_001", decision: "keep" }] } = {}) {
  client.uploadImage.mockResolvedValue(makeBothUploadResponse({ decisions }));
  const confirmed = decisions.map((d) => ({ itemId: d.itemId, aiDecision: d.decision, confirmedDecision: d.decision }));
  client.confirmDecisions.mockResolvedValue(makeConfirmResponse("run1", confirmed));

  const { result } = renderHook(() => useBothFlow());
  await act(async () => {
    await result.current.submit({ file: makeFile(), context: null });
  });
  await act(async () => {
    await result.current.confirm();
  });
  return { result, confirmed };
}

// ---------------------------------------------------------------------------

describe("useBothFlow, upload", () => {
  test("submit() sends path=\"both\" and stores the normalised declutter result plus the hash", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    const { result } = renderHook(() => useBothFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ path: "both" }));
    expect(result.current.status).toBe("ready");
    expect(result.current.declutter.expected_item_ids).toEqual(["item_001"]);
    expect(result.current.inputImageSha256).toBe(HASH);
    expect(result.current.file).not.toBeNull(); // retained for the whole flow, unlike useDeclutterFlow
  });

  test("upload failure enters error state, same as Declutter", async () => {
    client.uploadImage.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useBothFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("We couldn't analyse your space.");
  });

  test("duplicate-labelled items resolve independently, joined purely by item_id", async () => {
    client.uploadImage.mockResolvedValue(
      makeBothUploadResponse({
        decisions: [
          { itemId: "item_001", decision: "keep", label: "picture frame" },
          { itemId: "item_002", decision: "sell", label: "picture frame" },
        ],
      })
    );
    const { result } = renderHook(() => useBothFlow());

    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    expect(result.current.items.map((i) => i.item_id)).toEqual(["item_001", "item_002"]);
    expect(result.current.reviewItems.find((i) => i.item_id === "item_001").ai_decision).toBe("keep");
    expect(result.current.reviewItems.find((i) => i.item_id === "item_002").ai_decision).toBe("sell");
  });
});

describe("useBothFlow, confirmation gates generation", () => {
  test("generate() is a no-op before any confirmation exists, no network call", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    const { result } = renderHook(() => useBothFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    let outcome;
    await act(async () => {
      outcome = await result.current.generate();
    });

    expect(outcome).toBeNull();
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
  });

  test("confirmation never auto-triggers generation", async () => {
    const { result } = await confirmedFlow();
    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
    expect(result.current.generationStatus).toBe("idle");
  });
});

describe("useBothFlow, empty confirmed Keep blocks generation", () => {
  test("generate() is a client-side no-op when confirmedKeepIds is empty, no network call", async () => {
    const { result } = await confirmedFlow({ decisions: [{ itemId: "item_001", decision: "sell" }] });
    expect(result.current.confirmation.confirmedKeepIds).toEqual([]);

    let outcome;
    await act(async () => {
      outcome = await result.current.generate();
    });

    expect(outcome).toBeNull();
    expect(client.generateConfirmedReorganisation).not.toHaveBeenCalled();
    expect(result.current.generationStatus).toBe("idle");
  });
});

describe("useBothFlow, generate request shape", () => {
  test("the exact declutter+overrides request reaches the client, never a selection list", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );

    await act(async () => {
      await result.current.generate();
    });

    const args = client.generateConfirmedReorganisation.mock.calls[0][0];
    expect(args.runId).toBe("run1");
    expect(args.declutter.expected_item_ids).toEqual(["item_001"]);
    expect(args.inputImageSha256).toBe(HASH);
    expect(args).not.toHaveProperty("selectedItemIds");
    expect(args).not.toHaveProperty("confirmedKeepIds");
    expect(args).not.toHaveProperty("denoiseStrength");
    expect(args).not.toHaveProperty("seed");
  });

  test("overrides applied before confirm() reach the request and change the confirmed Keep set", async () => {
    client.uploadImage.mockResolvedValue(
      makeBothUploadResponse({ decisions: [{ itemId: "item_001", decision: "discard" }] })
    );
    const { result } = renderHook(() => useBothFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    act(() => {
      result.current.setDecisionOverride("item_001", "keep");
    });

    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse("run1", [{ itemId: "item_001", aiDecision: "discard", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.confirmation.confirmedKeepIds).toEqual(["item_001"]);

    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "discard", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.generate();
    });

    const args = client.generateConfirmedReorganisation.mock.calls[0][0];
    expect(args.overrides).toEqual([{ item_id: "item_001", decision: "keep" }]);
  });

  test("a successful generated result is stored and cross-checked against the prior confirm", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.generationStatus).toBe("done");
    expect(result.current.generateResult.imageStatus).toBe("generated");
    expect(result.current.generateResult.confirmation.confirmedKeepIds).toEqual(["item_001"]);
  });

  test("an unavailable image result is a SUCCESSFUL generation result, not an error", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }], {
        imageStatus: "unavailable",
        unavailableReason: "timeout",
      })
    );

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.generationStatus).toBe("done");
    expect(result.current.generateResult.imageStatus).toBe("unavailable");
    expect(result.current.generateResult.imageUnavailableReason).toBe("timeout");
    expect(result.current.generateResult.image).toBeNull();
    expect(result.current.generateError).toBeNull();
  });

  test("a response whose confirmed_keep_ids drifts from the prior /confirm result is rejected", async () => {
    // Both items are genuinely expected (a real matched-pair declutter),
    // but the client's own /confirm only ever reported item_001 as Keep.
    const { result } = await confirmedFlow({
      decisions: [
        { itemId: "item_001", decision: "keep" },
        { itemId: "item_002", decision: "sell" },
      ],
    });
    expect(result.current.confirmation.confirmedKeepIds).toEqual(["item_001"]);

    // The server response now (wrongly) claims item_002 was ALSO
    // confirmed Keep, never something the client's own /confirm reported.
    const drifted = makeConfirmedGenerateResponse("run1", [
      { itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" },
      { itemId: "item_002", aiDecision: "sell", confirmedDecision: "keep" },
    ]);
    client.generateConfirmedReorganisation.mockResolvedValue(drifted);

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.generationStatus).toBe("error");
    expect(result.current.generateError).toBe("We couldn't create your tidy plan.");
  });
});

describe("useBothFlow, generation-invalidating edits", () => {
  async function confirmedAndGenerated() {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.generationStatus).toBe("done");
    return result;
  }

  test("a new upload invalidates a completed generation", async () => {
    const result = await confirmedAndGenerated();
    client.uploadImage.mockResolvedValueOnce(makeBothUploadResponse({ runId: "run2" }));
    await act(async () => {
      await result.current.submit({ file: makeFile("room2.png"), context: null });
    });
    expect(result.current.generateResult).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
  });

  test("setDecisionOverride invalidates a completed generation", async () => {
    const result = await confirmedAndGenerated();
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    expect(result.current.generateResult).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
    // The composed hook's own behavior is untouched, confirmation is
    // ALSO invalidated (existing useDeclutterFlow behavior), reused here.
    expect(result.current.confirmation).toBeNull();
  });

  test("setItemExcluded invalidates a completed generation", async () => {
    const result = await confirmedAndGenerated();
    act(() => {
      result.current.setItemExcluded("item_001", true);
    });
    expect(result.current.generateResult).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
  });

  test("clearDecisionOverride invalidates a completed generation", async () => {
    const result = await confirmedAndGenerated();
    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    act(() => {
      result.current.clearDecisionOverride("item_001");
    });
    expect(result.current.generateResult).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
  });

  test("a label correction invalidates a completed generation the moment it starts", async () => {
    const result = await confirmedAndGenerated();
    client.overrideItem.mockResolvedValue({
      run_id: "run1",
      analysis: {
        run_id: "run1",
        scene: { label: "bedroom", confidence: 0.9, all_scores: { bedroom: 0.9 } },
        items: [makeItem({ item_id: "item_001", corrected_label: "hoodie", label_source: "user", effective_label: "hoodie" })],
        warnings: [],
        stage_timings: [],
      },
      declutter: {
        run_id: "run1",
        expected_item_ids: ["item_001"],
        ai_decisions: [{ item_id: "item_001", decision: "sell", reason: "still wearable" }],
        unresolved_item_ids: [],
        item_validity: { item_001: "raw_valid" },
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
    });

    act(() => {
      result.current.correctLabel("item_001", "hoodie");
    });

    expect(result.current.generateResult).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
    expect(result.current.correctingItemId).toBe("item_001");
  });

  test("correctLabel's synchronous validation-throw contract survives wrapping", async () => {
    const result = await confirmedAndGenerated();
    expect(() => result.current.correctLabel("item_999", "hoodie")).toThrow(/not an expected item/);
    // A rejected, never-dispatched correction must not touch a valid completed generation.
    expect(result.current.generateResult).not.toBeNull();
    expect(client.overrideItem).not.toHaveBeenCalled();
  });

  test("a fresh confirm() invalidates a completed generation", async () => {
    const result = await confirmedAndGenerated();
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.generateResult).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
  });
});

describe("useBothFlow, staleness", () => {
  test("a stale generate() success is discarded after a newer edit invalidates it", async () => {
    const { result } = await confirmedFlow();
    const slow = deferred();
    client.generateConfirmedReorganisation.mockReturnValueOnce(slow.promise);

    act(() => {
      result.current.generate();
    });
    expect(result.current.generationStatus).toBe("generating");

    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });
    expect(result.current.generationStatus).toBe("idle");

    await act(async () => {
      slow.resolve(
        makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
      );
      await slow.promise.catch(() => {});
    });

    expect(result.current.generateResult).toBeNull(); // discarded, not applied
    expect(result.current.generationStatus).toBe("idle");
  });

  test("a stale generate() REJECTION is also discarded, not surfaced as a fresh error", async () => {
    const { result } = await confirmedFlow();
    const slow = deferred();
    client.generateConfirmedReorganisation.mockReturnValueOnce(slow.promise);

    act(() => {
      result.current.generate();
    });

    act(() => {
      result.current.reset();
    });

    await act(async () => {
      slow.reject(new Error("stale failure, must be ignored"));
      await slow.promise.catch(() => {});
    });

    expect(result.current.generateError).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  test("a stale confirmation response is discarded and does not affect generation state", async () => {
    client.uploadImage.mockResolvedValue(makeBothUploadResponse());
    const { result } = renderHook(() => useBothFlow());
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });

    const slow = deferred();
    client.confirmDecisions.mockReturnValueOnce(slow.promise);
    act(() => {
      result.current.confirm();
    });

    act(() => {
      result.current.setDecisionOverride("item_001", "donate");
    });

    await act(async () => {
      slow.resolve(makeConfirmResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }]));
      await slow.promise;
    });

    expect(result.current.confirmation).toBeNull(); // discarded, superseded by the edit
    expect(result.current.generationStatus).toBe("idle");
  });
});

describe("useBothFlow, ownership token concurrency", () => {
  test("a fast double-click dispatches exactly one network call", async () => {
    const { result } = await confirmedFlow();
    const slow = deferred();
    client.generateConfirmedReorganisation.mockReturnValue(slow.promise);

    let first, second;
    act(() => {
      first = result.current.generate();
      second = result.current.generate(); // fired while the first is already in flight
    });

    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(
        makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
      );
      await Promise.all([first, second]);
    });

    expect(await second).toBeNull();
  });

  test("reset() releases the slot immediately, a new generate() need not wait for a stale one to settle", async () => {
    const { result } = await confirmedFlow();
    const slow = deferred();
    client.generateConfirmedReorganisation.mockReturnValueOnce(slow.promise);

    act(() => {
      result.current.generate();
    });
    expect(result.current.generationStatus).toBe("generating");

    act(() => {
      result.current.reset();
    });

    // Re-drive to a fresh confirmed state and generate again, must not
    // be blocked by the still-unsettled first call.
    client.uploadImage.mockResolvedValue(makeBothUploadResponse({ runId: "run2" }));
    await act(async () => {
      await result.current.submit({ file: makeFile(), context: null });
    });
    client.confirmDecisions.mockResolvedValue(
      makeConfirmResponse("run2", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.confirm();
    });

    client.generateConfirmedReorganisation.mockResolvedValueOnce(
      makeConfirmedGenerateResponse("run2", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.generate();
    });

    expect(client.generateConfirmedReorganisation).toHaveBeenCalledTimes(2); // the stale first call + this new one
    expect(result.current.generationStatus).toBe("done");

    await act(async () => {
      slow.resolve(
        makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
      );
      await slow.promise.catch(() => {});
    });
    // The stale first call settling late must not clobber the newer result.
    expect(result.current.generateResult.confirmation.runId).toBe("run2");
  });
});

describe("useBothFlow, recoverable generation errors", () => {
  test("a generate() failure preserves confirmation, file, context, and overrides", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("<html>ngrok failure</html>"));

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.generationStatus).toBe("error");
    expect(result.current.generateError).toBe("We couldn't create your tidy plan.");
    expect(result.current.confirmation).not.toBeNull(); // untouched
    expect(result.current.confirmationStatus).toBe("confirmed");
    expect(result.current.file).not.toBeNull();
    expect(result.current.declutter).not.toBeNull();
  });

  test("retrying after a failure calls the client again without re-uploading or re-confirming", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockRejectedValueOnce(new Error("first attempt failed"));
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.generationStatus).toBe("error");

    client.generateConfirmedReorganisation.mockResolvedValueOnce(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.generate();
    });

    expect(client.uploadImage).toHaveBeenCalledTimes(1); // no re-upload
    expect(client.confirmDecisions).toHaveBeenCalledTimes(1); // no re-confirmation
    expect(result.current.generationStatus).toBe("done");
  });
});

describe("useBothFlow, reset()", () => {
  test("reset() clears file, context, generation state, and the composed Declutter state", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.generateResult).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.file).toBeNull();
    expect(result.current.context).toBeNull();
    expect(result.current.generateResult).toBeNull();
    expect(result.current.generateError).toBeNull();
    expect(result.current.generationStatus).toBe("idle");
    expect(result.current.status).toBe("idle");
    expect(result.current.analysis).toBeNull();
    expect(result.current.declutter).toBeNull();
    expect(result.current.confirmation).toBeNull();
  });
});

// ===========================================================================
// Marketplace listing domain (Stage 3): composed through useDeclutterFlow,
// fully independent of Both's Reorganise generate domain.
// ===========================================================================

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

function batchResp(confirmResponse, drafts) {
  const nonEmpty = drafts.length > 0;
  return {
    run_id: "run1",
    confirmation: JSON.parse(JSON.stringify(confirmResponse)),
    drafts,
    model_name: nonEmpty ? "phi4-mini" : null,
    prompt_version: nonEmpty ? "v1" : null,
    max_attempts: nonEmpty ? 3 : null,
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

// item_001 Keep (feeds Reorganise), item_002 Sell "book" (feeds listing).
const KEEP_AND_SELL = [
  { itemId: "item_001", decision: "keep", label: "lamp" },
  { itemId: "item_002", decision: "sell", label: "book" },
];

async function bothConfirmed({ decisions = KEEP_AND_SELL, listingApi = makeListingApi() } = {}) {
  client.uploadImage.mockResolvedValue(makeBothUploadResponse({ decisions }));
  const confirmed = decisions.map((d) => ({ itemId: d.itemId, aiDecision: d.decision, confirmedDecision: d.decision }));
  const confirmResponse = makeConfirmResponse("run1", confirmed);
  client.confirmDecisions.mockResolvedValue(confirmResponse);

  const { result } = renderHook(() => useBothFlow({ listingApi }));
  await act(async () => {
    await result.current.submit({ file: makeFile(), context: null });
  });
  await act(async () => {
    await result.current.confirm();
  });
  return { result, listingApi, confirmResponse, confirmed };
}

async function bothListingReady(opts = {}) {
  const ctx = await bothConfirmed(opts);
  ctx.listingApi.generateListings.mockResolvedValue(batchResp(ctx.confirmResponse, [genDraft("item_002", "book")]));
  await act(async () => {
    await ctx.result.current.generateListingDrafts();
  });
  return ctx;
}

async function bothReorganiseDone(ctx) {
  client.generateConfirmedReorganisation.mockResolvedValue(
    makeConfirmedGenerateResponse("run1", ctx.confirmed)
  );
  await act(async () => {
    await ctx.result.current.generate();
  });
}

describe("useBothFlow, listing domain composition + independence from Reorganise", () => {
  test("the listingApi seam is passed through to the composed Declutter flow", async () => {
    const { result, listingApi } = await bothListingReady();
    expect(listingApi.generateListings).toHaveBeenCalledTimes(1);
    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.listingDrafts.map((d) => d.item_id)).toEqual(["item_002"]);
  });

  test("a listing failure does not clear a completed Reorganise result", async () => {
    const ctx = await bothConfirmed();
    await bothReorganiseDone(ctx);
    expect(ctx.result.current.generationStatus).toBe("done");
    const reorgResult = ctx.result.current.generateResult;

    ctx.listingApi.generateListings.mockRejectedValue(new Error("listing down"));
    await act(async () => {
      await ctx.result.current.generateListingDrafts();
    });

    expect(ctx.result.current.listingStatus).toBe("error");
    expect(ctx.result.current.generationStatus).toBe("done"); // untouched
    expect(ctx.result.current.generateResult).toBe(reorgResult);
    expect(ctx.result.current.generateError).toBeNull();
  });

  test("a Reorganise failure does not clear listing state", async () => {
    const ctx = await bothListingReady();
    const listingResultBefore = ctx.result.current.listingResult;

    client.generateConfirmedReorganisation.mockRejectedValue(new Error("colab down"));
    await act(async () => {
      await ctx.result.current.generate();
    });

    expect(ctx.result.current.generationStatus).toBe("error");
    expect(ctx.result.current.listingStatus).toBe("ready"); // untouched
    expect(ctx.result.current.listingResult).toBe(listingResultBefore);
  });

  test("listing activity does not claim or release the Reorganise slot", async () => {
    const ctx = await bothConfirmed();

    // A listing batch owns the LISTING slot...
    const d = deferred();
    ctx.listingApi.generateListings.mockReturnValueOnce(d.promise);
    let listingPromise;
    act(() => {
      listingPromise = ctx.result.current.generateListingDrafts();
    });
    expect(ctx.result.current.listingStatus).toBe("generating");

    // ...and a Reorganise generate can still be dispatched (its own slot).
    client.generateConfirmedReorganisation.mockResolvedValue(makeConfirmedGenerateResponse("run1", ctx.confirmed));
    await act(async () => {
      await ctx.result.current.generate();
    });
    expect(ctx.result.current.generationStatus).toBe("done");

    await act(async () => {
      d.resolve(batchResp(ctx.confirmResponse, [genDraft("item_002", "book")]));
      await listingPromise;
    });
    expect(ctx.result.current.listingStatus).toBe("ready");
  });

  test("Reorganise activity does not claim or release the listing slot", async () => {
    const ctx = await bothConfirmed();

    const rd = deferred();
    client.generateConfirmedReorganisation.mockReturnValueOnce(rd.promise);
    let genPromise;
    act(() => {
      genPromise = ctx.result.current.generate();
    });
    expect(ctx.result.current.generationStatus).toBe("generating");

    // A listing batch is unaffected by the in-flight Reorganise generate.
    ctx.listingApi.generateListings.mockResolvedValue(batchResp(ctx.confirmResponse, [genDraft("item_002", "book")]));
    await act(async () => {
      await ctx.result.current.generateListingDrafts();
    });
    expect(ctx.result.current.listingStatus).toBe("ready");

    await act(async () => {
      rd.resolve(makeConfirmedGenerateResponse("run1", ctx.confirmed));
      await genPromise;
    });
    expect(ctx.result.current.generationStatus).toBe("done");
  });

  test("a decision change in Both invalidates BOTH domains via their own owners", async () => {
    const ctx = await bothListingReady();
    await bothReorganiseDone(ctx);
    expect(ctx.result.current.listingStatus).toBe("ready");
    expect(ctx.result.current.generationStatus).toBe("done");

    await act(async () => {
      ctx.result.current.setDecisionOverride("item_001", "sell");
    });

    expect(ctx.result.current.listingStatus).toBe("idle");
    expect(ctx.result.current.listingResult).toBeNull();
    expect(ctx.result.current.generationStatus).toBe("idle");
    expect(ctx.result.current.generateResult).toBeNull();
  });

  test("reset invalidates both the listing and the Reorganise domains", async () => {
    const ctx = await bothListingReady();
    await bothReorganiseDone(ctx);

    await act(async () => {
      ctx.result.current.reset();
    });

    expect(ctx.result.current.listingStatus).toBe("idle");
    expect(ctx.result.current.listingResult).toBeNull();
    expect(ctx.result.current.generationStatus).toBe("idle");
    expect(ctx.result.current.generateResult).toBeNull();
    expect(ctx.result.current.confirmation).toBeNull();
  });

  test("listing regeneration in Both replaces only its target and never touches Reorganise", async () => {
    const ctx = await bothListingReady();
    await bothReorganiseDone(ctx);
    const reorgResult = ctx.result.current.generateResult;

    ctx.listingApi.regenerateListing.mockResolvedValue({
      run_id: "run1",
      confirmation: JSON.parse(JSON.stringify(ctx.confirmResponse)),
      draft: genDraft("item_002", "book", { title: "Regenerated" }),
      model_name: "phi4-mini",
      prompt_version: "v1",
      max_attempts: 3,
    });

    await act(async () => {
      await ctx.result.current.regenerateListingDraft("item_002");
    });

    expect(ctx.result.current.listingDrafts[0].edited_title).toBe("Regenerated");
    expect(ctx.result.current.generateResult).toBe(reorgResult); // Reorganise untouched
    expect(ctx.result.current.generationStatus).toBe("done");
  });

  test("existing Both generate() behaviour is unchanged when listing is never used", async () => {
    const { result } = await confirmedFlow();
    client.generateConfirmedReorganisation.mockResolvedValue(
      makeConfirmedGenerateResponse("run1", [{ itemId: "item_001", aiDecision: "keep", confirmedDecision: "keep" }])
    );
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.generationStatus).toBe("done");
    expect(result.current.listingStatus).toBe("idle");
  });
});
