// Every network call in the app lives here, once — per §4, no fetch()
// calls scattered inline inside components or hooks. hooks/ import from
// this file; they never call fetch directly.

import { fileToBase64 } from "../utils/fileEncoding";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

export function getBackendHealth() {
  return request("/health");
}

// §5: surfaced proactively in the UI (useImageGenHealth hook), not just
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
// — JSON body, distinct from overrideItem() below, which is the
// *label-correction* endpoint (/override — implemented on the backend,
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
// user rejects its detected label) — JSON body, like confirmDecisions,
// not the multipart shape this function used before /override was
// implemented. `analysis`/`declutter` are round-tripped whole, same
// reasoning as confirmDecisions above: the backend revalidates them
// (including that they're a genuine matched pair from the same run)
// rather than trusting anything the client claims. Distinct from
// setDecisionOverride()/confirmDecisions() — this never touches a
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

// POST /generate (Direct Reorganise, R4/R5) — JSON body, matching
// app/api/routes.py's GenerateRequest exactly (extra="forbid" there — an
// unrecognised field, including any tuning parameter, is a 422, never
// silently ignored). `analysis` is the exact validated AnalysisResult
// object POST /upload (path="reorganise") returned, round-tripped whole,
// same discipline as confirmDecisions()/overrideItem() above.
//
// Deliberately NEVER sends denoise_strength/controlnet_conditioning_scale
// /seed — R4 always uses the backend's configured defaults; these are
// provisional generation-tuning values, not an ordinary user decision
// (see app/services/reorganise_pipeline_service.py's own docstring).
//
// file.type is sent verbatim as image_media_type — validated here first
// (PNG/JPEG only, matching the backend's supported set) so an
// unsupported file type fails fast, client-side, with a clear message,
// rather than as a generic sanitized 422 from the network.
export async function generateReorganisation({
  runId,
  analysis,
  selectedItemIds,
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
      image,
      image_media_type: file.type,
      input_image_sha256: inputImageSha256,
      user_context: userContext,
    }),
  });
}

// POST /generate/confirmed (Both, R6) — matching app/api/routes.py's
// ConfirmedGenerateRequest exactly (extra="forbid" there too). Carries
// the INPUTS to confirmation (declutter + overrides), never confirmation
// OUTPUT: selection is derived entirely server-side from
// confirm_declutter_result() -> confirmed_keep_ids — this function
// deliberately has NO selectedItemIds/confirmedKeepIds parameter at all,
// so there is no way to accidentally send one. `declutter`/`overrides`
// are the exact same objects useBothFlow's composed useDeclutterFlow
// already holds — round-tripped whole, same discipline as every other
// object-carrying request in this file.
//
// Deliberately NEVER sends selected_item_ids, confirmed_keep_ids, or any
// generation-tuning field (denoise_strength/controlnet_conditioning_scale
// /seed) — same reasoning as generateReorganisation() above.
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
