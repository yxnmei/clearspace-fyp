import { itemNumberLabel } from "../utils/format";

// Renders the normalised GenerateResponse (useReorganiseFlow's
// generateResult), the structured plan is ALWAYS shown; the generated/
// unavailable image is the only part that varies by image_status. Zone
// items are joined back to the full analysis item list purely by
// item_id, never by label text, matching every other join in this
// codebase (declutterContract.js/confirmationContract.js).
//
// No visual-preview Retry button here, deliberately (R5 decision): the
// current /generate contract has no "regenerate image only" endpoint,
// a Retry would silently re-run Phi-4-mini planning again, real,
// non-trivial CPU cost, for what looks like a cheap "try again". Start
// over (a full reset) is the only recovery action offered until a
// future backend contract supports a genuinely cheap retry.
const UNAVAILABLE_REASON_COPY = {
  service_unreachable: "The image-generation service could not be reached.",
  timeout: "The image-generation request took too long and timed out.",
  request_failed: "The connection to the image-generation service failed.",
  service_error: "The image-generation service reported an error.",
  invalid_response: "The image-generation service returned an unexpected response.",
};

function ZoneList({ plan, items }) {
  const itemsById = new Map(items.map((item) => [item.item_id, item]));

  return (
    <div className="space-y-4">
      {plan.zones.map((zone) => (
        <div key={zone.zone_name} className="rounded-md border border-stone-200 bg-white p-4">
          <h3 className="mb-1 text-sm font-medium text-stone-900">{zone.zone_name}</h3>
          <p className="mb-2 text-sm text-stone-600">{zone.instruction}</p>
          <ul className="flex flex-wrap gap-2">
            {zone.item_ids.map((itemId) => {
              const item = itemsById.get(itemId);
              return (
                <li
                  key={itemId}
                  className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-stone-700"
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-stone-800 text-[10px] font-semibold text-white">
                    {itemNumberLabel(itemId)}
                  </span>
                  {item ? item.effective_label : itemId}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PlanningDetails({ planning }) {
  return (
    <details className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
      <summary className="cursor-pointer font-medium text-stone-900">Planning details</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-stone-500">Provenance</dt>
          <dd>{planning.provenance}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Attempts</dt>
          <dd>{planning.attempts}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Model</dt>
          <dd>{planning.model_name ?? "n/a"}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Prompt version</dt>
          <dd>{planning.prompt_version ?? "n/a"}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Planning duration</dt>
          <dd>{(planning.stage_timings[0].duration_ms / 1000).toFixed(2)}s</dd>
        </div>
      </dl>
      {planning.issues.length > 0 && (
        <div className="mt-3">
          <p className="text-stone-500">Issues encountered while planning:</p>
          <ul className="list-inside list-disc">
            {planning.issues.map((issue, i) => (
              <li key={i}>
                {issue.attempt}/{issue.kind}: {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3">
        <p className="text-stone-500">Image prompt (sent to the image-generation model):</p>
        <p className="whitespace-pre-wrap text-stone-700">{planning.plan.image_prompt}</p>
      </div>
    </details>
  );
}

function GenerationDetails({ image }) {
  return (
    <details className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
      <summary className="cursor-pointer font-medium text-stone-900">Generation details</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-stone-500">Base model</dt>
          <dd>{image.base_model}</dd>
        </div>
        <div>
          <dt className="text-stone-500">ControlNet model</dt>
          <dd>{image.controlnet_model}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Service version</dt>
          <dd>{image.service_version}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Generation time</dt>
          <dd>{(image.generation_ms / 1000).toFixed(1)}s</dd>
        </div>
        <div>
          <dt className="text-stone-500">Seed</dt>
          <dd>{image.seed}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Denoise / ControlNet scale</dt>
          <dd>
            {image.denoise_strength} / {image.controlnet_conditioning_scale}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">API version</dt>
          <dd>{image.api_version}</dd>
        </div>
        <div>
          <dt className="text-stone-500">Depth-conditioned</dt>
          <dd>{image.depth_map_used ? "Yes" : "No"}</dd>
        </div>
      </dl>
      <div className="mt-3 space-y-1 break-all font-mono text-xs text-stone-500">
        <p>Prompt hash: {image.prompt_sha256}</p>
        <p>Input-image hash: {image.input_image_sha256}</p>
      </div>
    </details>
  );
}

export default function ReorganiseResult({ generateResult, items, originalImageUrl, onStartOver }) {
  const { planning, imageStatus, image, imageUnavailableReason } = generateResult;

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-medium text-stone-900">Your room plan</h2>
        <ZoneList plan={planning.plan} items={items} />
        <div className="mt-3">
          <PlanningDetails planning={planning} />
        </div>
      </section>

      {imageStatus === "generated" ? (
        <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="mb-1 text-lg font-medium text-stone-900">Visual preview</h2>
          <p className="mb-4 text-sm text-stone-600">
            An AI-generated impression of the reorganised room, objects and layout may not be preserved exactly.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-sm font-medium text-stone-700">Before</p>
              {originalImageUrl && (
                <img
                  src={originalImageUrl}
                  alt="The original room photo you uploaded"
                  className="w-full rounded-md border border-stone-200 object-contain"
                />
              )}
            </div>
            <div>
              <p className="mb-1 text-sm font-medium text-stone-700">Reorganised</p>
              <img
                src={`data:${image.image_media_type};base64,${image.image}`}
                alt="AI-generated impression of the room, reorganised according to the plan above"
                className="w-full rounded-md border border-stone-200 object-contain"
              />
            </div>
          </div>
          <div className="mt-3">
            <GenerationDetails image={image} />
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-5">
          <h2 className="mb-1 text-lg font-medium text-amber-900">Visual preview unavailable</h2>
          <p className="text-sm text-amber-800">
            {UNAVAILABLE_REASON_COPY[imageUnavailableReason] ?? "The visual preview could not be generated."} Your
            room plan above is complete and unaffected.
          </p>
          <details className="mt-2 text-xs text-amber-700">
            <summary className="cursor-pointer">Technical detail</summary>
            <p className="mt-1">Reason code: {imageUnavailableReason}</p>
          </details>
        </section>
      )}

      <button
        type="button"
        onClick={onStartOver}
        className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        Start over
      </button>
    </div>
  );
}
