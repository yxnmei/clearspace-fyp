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

export function overrideItem({ itemId, newLabel, runId }) {
  const form = new FormData();
  form.append("item_id", itemId);
  form.append("new_label", newLabel);
  form.append("run_id", runId);
  return request("/override", { method: "POST", body: form });
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
