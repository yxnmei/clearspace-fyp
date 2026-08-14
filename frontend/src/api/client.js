// Every network call in the app lives here, once — per §4, no fetch()
// calls scattered inline inside components or hooks. hooks/ import from
// this file; they never call fetch directly.

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

export function generateReorganisation({ file, keptItemLabels, runId }) {
  const form = new FormData();
  form.append("image", file);
  keptItemLabels.forEach((label) => form.append("kept_item_labels", label));
  form.append("run_id", runId);
  return request("/generate", { method: "POST", body: form });
}
