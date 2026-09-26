// Nested analysis and decision inputs are round-tripped whole so the backend
// can revalidate them. Eligibility always remains server-derived.

import { fileToBase64 } from "../utils/fileEncoding";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

// The message is fixed and display-safe. status/detail are routing data only;
// raw response bodies never become displayed messages.
export class ApiError extends Error {
  constructor(status, detail = null) {
    super("The service could not complete the request. Please try again.");
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    let detail = null;
    try {
      const payload = await res.json();
      if (payload && typeof payload === "object" && "detail" in payload) {
        detail = payload.detail;
      }
    } catch {
      // Proxies may return HTML or text. Raw bodies never enter UI messages.
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export function getBackendHealth() {
  return request("/health");
}

export function getImageGenHealth() {
  return request("/image-gen/health");
}

export function uploadImage({ file, path, context }) {
  const form = new FormData();
  form.append("image", file);
  form.append("path", path); // "declutter" | "reorganise" | "both"
  if (context) form.append("context", context);
  return request("/upload", { method: "POST", body: form });
}

// Decision confirmation is distinct from label correction below.
export function confirmDecisions({ runId, declutter, overrides = [] }) {
  return request("/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, declutter, overrides }),
  });
}

// Label correction reruns reasoning for one item without directly setting its decision.
export function overrideItem({ runId, analysis, declutter, itemId, correctedLabel, userContext = null }) {
  return request("/override", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      analysis,
      declutter,
      item_id: itemId,
      corrected_label: correctedLabel,
      user_context: userContext,
    }),
  });
}

export function transcribeAudio({ audioBlob }) {
  const form = new FormData();
  form.append("audio", audioBlob);
  return request("/transcribe", { method: "POST", body: form });
}

// Label corrections stay separate from the unchanged analysis. Generation
// tuning remains backend-configured. Validate the media type before upload.
export async function generateReorganisation({
  runId,
  analysis,
  selectedItemIds,
  labelCorrections = [],
  file,
  inputImageSha256,
  userContext = null,
}) {
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    throw new Error(`generateReorganisation: file must be PNG or JPEG, got ${JSON.stringify(file.type)}`);
  }

  const image = await fileToBase64(file);

  return request("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      analysis,
      selected_item_ids: selectedItemIds,
      label_corrections: labelCorrections,
      image,
      image_media_type: file.type,
      input_image_sha256: inputImageSha256,
      user_context: userContext,
    }),
  });
}

// confirmed_keep_ids is derived server-side. This function deliberately has
// no selectedItemIds or confirmedKeepIds parameter and sends no tuning fields.
export async function generateConfirmedReorganisation({
  runId,
  analysis,
  declutter,
  overrides = [],
  file,
  inputImageSha256,
  userContext = null,
}) {
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    throw new Error(`generateConfirmedReorganisation: file must be PNG or JPEG, got ${JSON.stringify(file.type)}`);
  }

  const image = await fileToBase64(file);

  return request("/generate/confirmed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      analysis,
      declutter,
      overrides,
      image,
      image_media_type: file.type,
      input_image_sha256: inputImageSha256,
      user_context: userContext,
    }),
  });
}

// Eligible Sell ids and confirmation are derived server-side. This function
// deliberately has no eligibleItemIds or sellItemIds parameter. Seller details
// are metadata keyed by item_id and cannot make an item eligible.
export function generateListings({ runId, analysis, declutter, overrides = [], listingDetails = [] }) {
  return request("/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, analysis, declutter, overrides, listing_details: listingDetails }),
  });
}

// The encoded path alone selects the item. The backend remains authoritative
// for eligibility; local validation only rejects a blank id before fetch.
export async function regenerateListing({ runId, analysis, declutter, overrides = [], itemId, listingDetails = [] }) {
  if (typeof itemId !== "string" || itemId.trim() === "") {
    throw new Error(`regenerateListing: itemId must be a non-blank string, got ${JSON.stringify(itemId)}`);
  }

  return request(`/listings/${encodeURIComponent(itemId)}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, analysis, declutter, overrides, listing_details: listingDetails }),
  });
}
