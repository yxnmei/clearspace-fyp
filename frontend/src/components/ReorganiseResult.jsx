import { ImageOff, RotateCcw } from "lucide-react";
import ReorganiseChecklist from "./ReorganiseChecklist";
import StorageSuggestions from "./StorageSuggestions";
import { Button } from "./ui/button";

// Renders the normalised generate response (useReorganiseFlow's
// generateResult, or useBothFlow's) as one tidy plan: the heading, then
// the interactive phased plan beside the Before / AI preview from lg up
// (stacked below), then, only when present, the storage suggestions,
// then Start over. Direct Reorganise and Both both render this one
// component, so neither duplicates any of it.
//
// generateResult.focusAreas is still part of the normalised response and
// its contract (validated, joined by item_id) but is deliberately NOT
// rendered: its coarse counts are not actionable placement guidance.
//
// The visual is an impression built from a deterministic prompt (room
// type, selected items, your notes). It is never claimed to follow the
// phases step by step; the prompt is built separately and deterministically.
//
// No visual-preview Retry button here, deliberately (R5 decision): the
// current /generate contract has no "regenerate image only" endpoint,
// a Retry would silently re-run the whole pipeline for what looks like
// a cheap image-only action. Start
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
          tidy plan is ready to use without it.
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
        An AI-generated impression of a tidier version of your space. It may not preserve every object or its exact
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
              alt="The original space photo you uploaded"
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
            alt="AI-generated impression of a tidier version of the space"
            className="w-full rounded-card border border-border bg-surface-muted object-contain"
          />
        </figure>
      </div>
    </section>
  );
}

// The result needs no item list: focus areas are not shown and the
// storage cards carry their own grounded reason, so neither page passes
// one.
//
// `heading` defaults to Direct Reorganise's "Your tidy plan"; Both passes
// "Tidy up" so this section IS its Tidy up result section. Start over is
// rendered only when `onStartOver` is supplied: Direct Reorganise supplies
// it (a reset of that one workflow), Both does not, because there a
// whole-workflow reset inside the tidy plan would read as a Tidy-only
// action, so Both renders one global Start over after both result
// sections instead.
export default function ReorganiseResult({ generateResult, originalImageUrl, onStartOver, heading = "Your tidy plan" }) {
  const { tidyPlan, storageSuggestions, imageStatus, image, imageUnavailableReason } = generateResult;
  // A real, stable primitive identity for this result: a different run
  // remounts the checklist, so its local completion starts empty.
  const resultKey = generateResult.runId;

  return (
    <section aria-labelledby="tidy-plan-heading" className="mt-6 space-y-6">
      <header>
        <h2 id="tidy-plan-heading" className="text-title font-semibold tracking-tight text-foreground">
          {heading}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Work through the phases at your own pace. The visual preview is an impression of a tidier space, not a
          precise placement plan.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <ReorganiseChecklist key={resultKey} tidyPlan={tidyPlan} />
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

      {onStartOver ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onStartOver}>
            <RotateCcw aria-hidden="true" width={14} height={14} />
            Start over
          </Button>
        </div>
      ) : null}
    </section>
  );
}
