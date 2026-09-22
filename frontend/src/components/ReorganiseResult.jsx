import { ImageOff, RotateCcw } from "lucide-react";
import ReorganiseChecklist from "./ReorganiseChecklist";
import StorageSuggestions from "./StorageSuggestions";
import { Button } from "./ui/button";

// Renders the normalised generate response (useReorganiseFlow's
// generateResult, or useBothFlow's) as one tidy plan: the heading, then
// the interactive checklist beside the Before / AI preview from lg up
// (stacked below), then, only when present, the storage suggestions,
// then Start over. Direct Reorganise and Both both render this one
// component, so neither duplicates any of it.
//
// generateResult.focusAreas is still part of the normalised response and
// its contract (validated, joined by item_id) but is deliberately NOT
// rendered: the checklist already walks the same left / centre / right
// grouping, so showing it again duplicated the plan.
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
//
// Technical fields (model, seed, ControlNet, service/API version, timing,
// prompt, hashes, provenance, attempts, unavailable reason codes) remain
// in the normalised result and its contract, as do the focus areas; they
// are simply not shown.
const UNAVAILABLE_REASON_COPY = {
  service_unreachable: "The image service could not be reached.",
  timeout: "The image took too long to generate.",
  request_failed: "The connection to the image service failed.",
  service_error: "The image service reported a problem.",
  invalid_response: "The image service sent back something ClearSpace could not use.",
};

function VisualPreview({ imageStatus, image, imageUnavailableReason, originalImageUrl }) {
  if (imageStatus !== "generated") {
    return (
      <section
        aria-labelledby="visual-preview-unavailable-heading"
        className="rounded-card border border-warning/40 bg-warning/10 p-4 sm:p-5"
      >
        <h3 id="visual-preview-unavailable-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <ImageOff aria-hidden="true" width={18} height={18} className="shrink-0 text-warning" />
          Visual preview unavailable
        </h3>
        <p className="mt-1 text-sm text-foreground">
          {UNAVAILABLE_REASON_COPY[imageUnavailableReason] ?? "The visual preview could not be generated."} Your
          checklist is complete and ready to use without it.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="visual-preview-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <h3 id="visual-preview-heading" className="text-lg font-semibold text-foreground">
        Visual preview
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        An AI-generated impression of a tidier version of your room. It may not preserve every object or its exact
        placement.
      </p>
      {/* Side by side from sm; back to a stack in the narrower lg column
          beside the checklist, side by side again from xl. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <figure>
          <figcaption className="mb-1 text-sm font-medium text-foreground">Before</figcaption>
          {originalImageUrl ? (
            <img
              src={originalImageUrl}
              alt="The original room photo you uploaded"
              className="w-full rounded-card border border-border bg-surface-muted object-contain"
            />
          ) : (
            <p className="rounded-card border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
              Original photo unavailable.
            </p>
          )}
        </figure>
        <figure>
          <figcaption className="mb-1 text-sm font-medium text-foreground">AI preview</figcaption>
          <img
            src={`data:${image.image_media_type};base64,${image.image}`}
            alt="AI-generated impression of a tidier version of the room"
            className="w-full rounded-card border border-border bg-surface-muted object-contain"
          />
        </figure>
      </div>
    </section>
  );
}

// `items` is still passed by both pages for the contract join; nothing
// rendered here needs it any more (focus areas are not shown and the
// storage cards carry their own grounded reason), so it is not read.
export default function ReorganiseResult({ generateResult, originalImageUrl, onStartOver }) {
  const { actionPlan, storageSuggestions, imageStatus, image, imageUnavailableReason } = generateResult;
  // A real, stable primitive identity for this result: a different run
  // remounts the checklist, so its local completion starts empty.
  const resultKey = generateResult.runId ?? actionPlan.run_id;

  return (
    <section aria-labelledby="tidy-plan-heading" className="mt-6 space-y-6">
      <header>
        <h2 id="tidy-plan-heading" className="text-title font-semibold tracking-tight text-foreground">
          Your tidy plan
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Work through the checklist at your own pace. The visual preview is an impression of a tidier room, not a
          precise placement plan.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <ReorganiseChecklist key={resultKey} actionPlan={actionPlan} />
        <VisualPreview
          imageStatus={imageStatus}
          image={image}
          imageUnavailableReason={imageUnavailableReason}
          originalImageUrl={originalImageUrl}
        />
      </div>

      {/* Renders nothing at all when there are no suggestions: no empty
          column, no placeholder. The cards show only name + reason;
          related_item_ids stay in the result but are not displayed. */}
      <StorageSuggestions storageSuggestions={storageSuggestions} />

      <div>
        <Button type="button" variant="outline" size="sm" onClick={onStartOver}>
          <RotateCcw aria-hidden="true" width={14} height={14} />
          Start over
        </Button>
      </div>
    </section>
  );
}
