import { useState } from "react";
import { ImageOff, Maximize2, RotateCcw } from "lucide-react";
import ImageLightbox from "./ImageLightbox";
import ReorganiseChecklist from "./ReorganiseChecklist";
import StorageSuggestions from "./StorageSuggestions";
import { Button } from "./ui/button";

// Shared Direct/Both result. Focus areas and technical provenance remain in
// the contract but are not displayed. There is no image-only retry endpoint,
// so Start over is the only honest recovery action.
const EXPAND_BUTTON_CLASS = "absolute right-2 top-2 bg-surface/90 text-xs shadow-card backdrop-blur hover:bg-surface";

const UNAVAILABLE_REASON_COPY = {
  service_unreachable: "The image service could not be reached.",
  timeout: "The image took too long to generate.",
  request_failed: "The connection to the image service failed.",
  service_error: "The image service reported a problem.",
  invalid_response: "The image service sent back something ClearSpace could not use.",
};

function VisualPreview({ imageStatus, image, imageUnavailableReason, originalImageUrl }) {
  // Keep hook order stable before the unavailable early return.
  const [enlarged, setEnlarged] = useState(null);
  const previewSrc = image ? `data:${image.image_media_type};base64,${image.image}` : null;

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
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <figure>
          <figcaption className="mb-1 text-sm font-medium text-foreground">Before</figcaption>
          {originalImageUrl ? (
            <div className="relative">
              <img
                src={originalImageUrl}
                alt="The original space photo you uploaded"
                className="w-full rounded-card border border-border bg-surface-muted object-contain"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={EXPAND_BUTTON_CLASS}
                onClick={() => setEnlarged("before")}
              >
                <Maximize2 aria-hidden="true" width={14} height={14} />
                Expand image
              </Button>
            </div>
          ) : (
            <p className="rounded-card border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
              Original photo unavailable.
            </p>
          )}
        </figure>
        <figure>
          <figcaption className="mb-1 text-sm font-medium text-foreground">AI preview</figcaption>
          <div className="relative">
            <img
              src={previewSrc}
              alt="AI-generated impression of a tidier version of the space"
              className="w-full rounded-card border border-border bg-surface-muted object-contain"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={EXPAND_BUTTON_CLASS}
              onClick={() => setEnlarged("preview")}
            >
              <Maximize2 aria-hidden="true" width={14} height={14} />
              Expand image
            </Button>
          </div>
        </figure>
      </div>

      <ImageLightbox
        open={enlarged !== null}
        onClose={() => setEnlarged(null)}
        src={enlarged === "before" ? originalImageUrl : previewSrc}
        alt={
          enlarged === "before"
            ? "The original space photo you uploaded"
            : "AI-generated impression of a tidier version of the space"
        }
        title={enlarged === "before" ? "Before" : "AI preview"}
        description={
          enlarged === "before"
            ? undefined
            : "An impression of a tidier space. It may not preserve every object or its exact placement."
        }
      />
    </section>
  );
}

// Both supplies its heading and renders one global reset outside this section.
export default function ReorganiseResult({ generateResult, originalImageUrl, onStartOver, heading = "Your tidy plan" }) {
  const { tidyPlan, storageSuggestions, imageStatus, image, imageUnavailableReason } = generateResult;
  // A new run remounts the checklist and clears its local completion state.
  const resultKey = generateResult.runId;

  return (
    <section aria-labelledby="tidy-plan-heading" className="mt-6 space-y-6">
      <header>
        <h2 id="tidy-plan-heading" className="text-title font-semibold tracking-tight text-foreground">
          {heading}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Work through the phases in order. The preview is an impression, not a placement plan.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <ReorganiseChecklist key={resultKey} tidyPlan={tidyPlan} />
        <div className="space-y-6">
          <VisualPreview
            imageStatus={imageStatus}
            image={image}
            imageUnavailableReason={imageUnavailableReason}
            originalImageUrl={originalImageUrl}
          />
          <StorageSuggestions storageSuggestions={storageSuggestions} />
        </div>
      </div>

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
