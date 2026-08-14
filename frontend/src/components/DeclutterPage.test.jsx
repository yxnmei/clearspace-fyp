import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import DeclutterPage from "./DeclutterPage";
import * as client from "../api/client";

// Only the network boundary is mocked (matches useDeclutterFlow.test.jsx's
// convention) — the real hook, real contract adapters, and every
// component down to AnalysedRoomPanel run for real, so this proves the
// actual wiring, not just that mocked pieces were called.
vi.mock("../api/client", () => ({
  uploadImage: vi.fn(),
  confirmDecisions: vi.fn(),
  overrideItem: vi.fn(),
}));

function makeFile(name) {
  return new File(["fake bytes"], name, { type: "image/jpeg" });
}

function makeUploadResponse(runId) {
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
          confidence: 0.8,
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
      ai_decisions: [{ item_id: "item_001", decision: "keep", reason: "still useful" }],
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
  };
}

let nextUrlSuffix = 0;

beforeEach(() => {
  vi.clearAllMocks();
  nextUrlSuffix = 0;
  global.URL.createObjectURL = vi.fn(() => `blob:mock-${nextUrlSuffix++}`);
  global.URL.revokeObjectURL = vi.fn();
});

describe("DeclutterPage", () => {
  test("the analysed-room panel shows the image that was actually submitted, not whatever the form currently shows", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse("run-a"));
    render(<DeclutterPage />);

    const fileA = makeFile("room-a.jpg");
    await user.upload(screen.getByLabelText(/room photo/i), fileA);
    await user.click(screen.getByRole("button", { name: /analyse room/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /analysis summary/i })).toBeInTheDocument());
    const analysedImgSrcAfterFirstRun = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
    expect(analysedImgSrcAfterFirstRun).toBeTruthy();

    // Select a DIFFERENT file in the form WITHOUT submitting — the form's
    // own picker preview updates, but the still-showing analysis (from
    // fileA) must not be reattributed to the new, unanalysed file.
    const fileB = makeFile("room-b.jpg");
    await user.upload(screen.getByLabelText(/room photo/i), fileB);

    const analysedImgSrcAfterReselect = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
    expect(analysedImgSrcAfterReselect).toBe(analysedImgSrcAfterFirstRun); // unchanged

    // Now actually submit fileB — only NOW should the analysed panel move on.
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse("run-b"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(client.uploadImage).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const src = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");
      expect(src).not.toBe(analysedImgSrcAfterFirstRun);
    });
  });

  test("the previous analysed image's object URL is revoked once a new one replaces it", async () => {
    const user = userEvent.setup();
    client.uploadImage.mockResolvedValueOnce(makeUploadResponse("run-a"));
    render(<DeclutterPage />);

    await user.upload(screen.getByLabelText(/room photo/i), makeFile("room-a.jpg"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /analysis summary/i })).toBeInTheDocument());
    const firstAnalysedSrc = screen.getByRole("img", { name: /detected item outlines/i }).getAttribute("src");

    client.uploadImage.mockResolvedValueOnce(makeUploadResponse("run-b"));
    await user.upload(screen.getByLabelText(/room photo/i), makeFile("room-b.jpg"));
    await user.click(screen.getByRole("button", { name: /analyse room/i }));
    await waitFor(() => expect(client.uploadImage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstAnalysedSrc));
  });
});
