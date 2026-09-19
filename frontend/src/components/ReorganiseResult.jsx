import ReorganiseChecklist from "./ReorganiseChecklist";
import FocusAreas from "./FocusAreas";
import StorageSuggestions from "./StorageSuggestions";

// Renders the normalised generate response (useReorganiseFlow's
// generateResult, or useBothFlow's) in a fixed order: the checklist, the
// focus areas, the storage suggestions, then the visual preview. The
// first three are ALWAYS shown; the generated/unavailable image is the
// only part that varies by image_status. Direct Reorganise and Both both
// render this one component, so neither duplicates any of it.
//
// The visual is an impression built from a deterministic prompt (room
// type, selected items, your notes). It is never claimed to follow the
// checklist step by step, and the checklist model never writes the
// image prompt.
//
// No visual-preview Retry button here, deliberately (R5 decision): the
// current /generate contract has no "regenerate image only" endpoint,
// a Retry would silently re-run the checklist call as well, real,
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

function GenerationDetails({ image, imagePrompt }) {
  return (
    <details className="rounded-control border border-border bg-surface-muted p-3 text-sm text-foreground">
      <summary className="cursor-pointer font-medium">Generation details</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Base model</dt>
          <dd>{image.base_model}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">ControlNet model</dt>
          <dd>{image.controlnet_model}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Service version</dt>
          <dd>{image.service_version}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Generation time</dt>
          <dd>{(image.generation_ms / 1000).toFixed(1)}s</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Seed</dt>
          <dd>{image.seed}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Denoise / ControlNet scale</dt>
          <dd>
            {image.denoise_strength} / {image.controlnet_conditioning_scale}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">API version</dt>
          <dd>{image.api_version}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Depth-conditioned</dt>
          <dd>{image.depth_map_used ? "Yes" : "No"}</dd>
        </div>
      </dl>
      <div className="mt-3">
        <p className="text-muted-foreground">Image prompt (sent to the image-generation model):</p>
        <p className="whitespace-pre-wrap">{imagePrompt}</p>
      </div>
      <div className="mt-3 space-y-1 break-all font-mono text-xs text-muted-foreground">
        <p>Prompt hash: {image.prompt_sha256}</p>
        <p>Input-image hash: {image.input_image_sha256}</p>
      </div>
    </details>
  );
}

export default function ReorganiseResult({ generateResult, items, originalImageUrl, onStartOver }) {
  const { actionPlan, focusAreas, storageSuggestions, imagePrompt, imageStatus, image, imageUnavailableReason } =
    generateResult;

  return (
    <div className="mt-6 space-y-6">
      <ReorganiseChecklist actionPlan={actionPlan} />

      <FocusAreas focusAreas={focusAreas} items={items} />

      <StorageSuggestions storageSuggestions={storageSuggestions} items={items} />

      {imageStatus === "generated" ? (
        <section aria-labelledby="visual-preview-heading" className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
          <h2 id="visual-preview-heading" className="text-lg font-semibold text-foreground">
            Visual preview
          </h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">
            An AI-generated impression of a tidier version of your room, made from your selected items and notes.
            Objects and layout may not be preserved exactly, and the picture does not follow the checklist step by
            step.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-sm font-medium text-foreground">Before</p>
              {originalImageUrl && (
                <img
                  src={originalImageUrl}
                  alt="The original room photo you uploaded"
                  className="w-full rounded-card border border-border object-contain"
                />
              )}
            </div>
            <div>
              <p className="mb-1 text-sm font-medium text-foreground">Reorganised</p>
              <img
                src={`data:${image.image_media_type};base64,${image.image}`}
                alt="AI-generated impression of a tidier version of the room"
                className="w-full rounded-card border border-border object-contain"
              />
            </div>
          </div>
          <div className="mt-3">
            <GenerationDetails image={image} imagePrompt={imagePrompt} />
          </div>
        </section>
      ) : (
        <section aria-labelledby="visual-preview-unavailable-heading" className="rounded-card border border-warning/40 bg-warning/10 p-5 sm:p-6">
          <h2 id="visual-preview-unavailable-heading" className="text-lg font-semibold text-foreground">
            Visual preview unavailable
          </h2>
          <p className="mt-1 text-sm text-foreground">
            {UNAVAILABLE_REASON_COPY[imageUnavailableReason] ?? "The visual preview could not be generated."} Your
            checklist, focus areas and storage suggestions above are complete and unaffected.
          </p>
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Technical detail</summary>
            <p className="mt-1">Reason code: {imageUnavailableReason}</p>
            <p className="mt-1">Image prompt that would have been sent:</p>
            <p className="whitespace-pre-wrap">{imagePrompt}</p>
          </details>
        </section>
      )}

      <button
        type="button"
        onClick={onStartOver}
        className="rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        Start over
      </button>
    </div>
  );
}
