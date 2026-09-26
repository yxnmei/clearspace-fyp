// Every network call in the app lives here, with no fetch() calls
// scattered inline inside components or hooks. hooks/ import from
// this file; they never call fetch directly.

import { fileToBase64 } from "../utils/fileEncoding";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

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
      // A proxy may return HTML or plain text. Never copy it into the error.
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export function getBackendHealth() {
  return request("/health");
}

// Surfaced proactively in the UI (useImageGenHealth hook), not just
// wrapped in a try/catch around the real generate() call.
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

// Decision confirmation (Keep/Sell/Donate/Discard overrides + exclusion)
// JSON body, distinct from overrideItem() below, which is the
// *label-correction* endpoint (/override, implemented on the backend,
// see app/api/routes.py's OverrideRequest/OverrideResponse). Never send
// `declutter` reshaped/stripped: it's the exact validated nested object
// POST /upload returned, round-tripped whole so the backend can
// revalidate it (provenance/warnings/validity/timings included) rather
// than trusting anything the client claims about it.
export function confirmDecisions({ runId, declutter, overrides = [] }) {
  return request("/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, declutter, overrides }),
  });
}

// Label correction (re-run LLM reasoning for exactly one item after the
// user rejects its detected label), JSON body, like confirmDecisions,
// not the multipart shape this function used before /override was
// implemented. `analysis`/`declutter` are round-tripped whole, same
// reasoning as confirmDecisions above: the backend revalidates them
// (including that they're a genuine matched pair from the same run)
// rather than trusting anything the client claims. Distinct from
// setDecisionOverride()/confirmDecisions(), this never touches a
// Keep/Sell/Donate/Discard decision directly, only a label, which may
// change what decision the LLM produces as a side effect.
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

// POST /generate (Direct Reorganise), JSON body, matching
// app/api/routes.py's GenerateRequest exactly (extra="forbid" there, an
// unrecognised field, including any tuning parameter, is a 422, never
// silently ignored). `analysis` is the exact validated AnalysisResult
// object POST /upload (path="reorganise") returned, round-tripped whole,
// same discipline as confirmDecisions()/overrideItem() above.
//
// `labelCorrections` is the user's Select items label corrections, an
// array of { item_id, corrected_label }, sent as its own
// `label_corrections` field. The analysis itself is never edited to
// carry a correction (the backend rejects an analysis that does).
//
// Deliberately NEVER sends denoise_strength/controlnet_conditioning_scale
// /seed; Direct Reorganise always uses the backend's configured defaults.
// These are provisional generation-tuning values, not an ordinary user decision
// (see app/services/reorganise_pipeline_service.py's own docstring).
//
// file.type is sent verbatim as image_media_type, validated here first
// (PNG/JPEG only, matching the backend's supported set) so an
// unsupported file type fails fast, client-side, with a clear message,
// rather than as a generic sanitized 422 from the network.
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

// POST /generate/confirmed (Both), matching app/api/routes.py's
// ConfirmedGenerateRequest exactly (extra="forbid" there too). Carries
// the INPUTS to confirmation (declutter + overrides), never confirmation
// OUTPUT: selection is derived entirely server-side from
// confirm_declutter_result() -> confirmed_keep_ids, this function
// deliberately has NO selectedItemIds/confirmedKeepIds parameter at all,
// so there is no way to accidentally send one. `declutter`/`overrides`
// are the exact same objects useBothFlow's composed useDeclutterFlow
// already holds, round-tripped whole, same discipline as every other
// object-carrying request in this file.
//
// Deliberately NEVER sends selected_item_ids, confirmed_keep_ids, or any
// generation-tuning field (denoise_strength/controlnet_conditioning_scale
// /seed), same reasoning as generateReorganisation() above.
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

// POST /listings (marketplace listing draft generation),
// JSON body, matching app/api/routes.py's ListingRequest exactly
// (extra="forbid" there, so an unrecognised field is a 422, never
// silently ignored). Sends run_id, the whole round-tripped analysis and
// declutter, serialised overrides, and seller-supplied listing_details.
// The backend still derives the eligible Sell set and authoritative
// confirmation server-side from (declutter, overrides).
//
// Deliberately has NO eligibleItemIds/sellItemIds parameter at all, and
// never sends a confirmation, generated draft text, image data, user
// context, or model configuration, so there is no way to accidentally
// make any of those authoritative.
// `listingDetails` is the seller-supplied name / condition per item_id
// ({ item_id, listing_name, condition }[]), sent as an explicit structured
// field. Eligibility stays server-derived: details for a non-Sell item are
// ignored there, never honoured.
export function generateListings({ runId, analysis, declutter, overrides = [], listingDetails = [] }) {
  return request("/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, analysis, declutter, overrides, listing_details: listingDetails }),
  });
}

// POST /listings/{item_id}/regenerate (true single-item regeneration).
// The body is EXACTLY the same shape generateListings() sends (run_id +
// whole analysis + whole declutter + overrides + listing_details); the one item to
// regenerate is identified ONLY by the path segment, encodeURIComponent-
// encoded, and item_id is never repeated in the body.
//
// itemId is validated as a non-blank string here, before fetch, so a
// missing/blank id fails fast client-side rather than as a sanitized
// network error. Eligibility is NOT checked here, the backend is
// authoritative and rejects a non-eligible target itself.
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
