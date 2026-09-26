import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";

// Surfaces Colab/ngrok status in the UI itself, rather than only
// failing once someone clicks Create tidy plan. Purely presentational,
// status/recheck are passed in as props, this component never calls
// useImageGenHealth() itself. ReorganisePage and BothPage each own ONE
// instance of that hook (see their docstrings and useImageGenHealth.js's),
// so mounting a page issues exactly one GET /image-gen/health request,
// never two.
//
// Advisory only: this component renders nothing when status is
// "available", but even when it renders its "unavailable" message, it
// never disables anything, Create tidy plan stays available regardless
// (the backend deliberately plans first and returns a complete structured
// plan with image_status="unavailable" when Colab is offline; see
// app/services/reorganise_pipeline_service.py).
//
// Presentation follows the shared warning surface (warning border and
// tint, icon beside the text) and the Button primitive, stacking the
// message above the action on phones and sitting in one row from sm. It
// carries no live role of its own: the hosting section is not an
// announcement, and a recheck result changes this text in place.
export default function ImageGenStatusBanner({ status, recheck }) {
  if (status === "available") return null; // don't clutter the UI when everything's fine

  const isChecking = status === "checking";
  const message = isChecking
    ? "Checking image-generation availability…"
    : "Visual preview is currently unavailable. You can still create a tidy plan; only the AI-generated image will be missing.";

  return (
    <div className="flex flex-col gap-3 rounded-control border border-warning/40 bg-warning/10 p-3 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between">
      <p className="flex min-w-0 items-start gap-2">
        {isChecking ? (
          <Loader2 aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 animate-spin text-warning" />
        ) : (
          <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-warning" />
        )}
        <span>{message}</span>
      </p>
      {/* Disabled, not hidden, while a check is already in flight, a
          manual recheck() call here would race the one already running
          rather than usefully do anything. Label changes so a disabled
          button isn't mistaken for a stuck/broken one. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={recheck}
        disabled={isChecking}
        className="min-h-11 w-full shrink-0 sm:min-h-0 sm:w-auto"
      >
        {isChecking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}
