import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";

// Advisory health status only. It never disables tidy-plan generation because
// the structured plan remains available without an image.
export default function ImageGenStatusBanner({ status, recheck }) {
  if (status === "available") return null;

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
      {/* Disable recheck while the existing check owns the request. */}
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
