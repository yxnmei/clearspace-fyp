// §5: surfaces Colab/ngrok status in the UI itself, rather than only
// failing once someone clicks Generate. Purely presentational, status/
// recheck are passed in as props, this component never calls
// useImageGenHealth() itself. ReorganisePage is the ONE owner of that
// hook (see its own docstring and useImageGenHealth.js's), both this
// banner and the item-selection screen's advisory copy read from the
// SAME hook instance, so mounting the Reorganise page issues exactly one
// GET /image-gen/health request, never two.
//
// Advisory only: this component renders nothing when status is
// "available", but even when it renders its "unavailable" message, it
// never disables anything, Generate stays available regardless (the
// backend deliberately plans first and returns a complete structured
// plan with image_status="unavailable" when Colab is offline; see
// app/services/reorganise_pipeline_service.py).
export default function ImageGenStatusBanner({ status, recheck }) {
  if (status === "available") return null; // don't clutter the UI when everything's fine

  const message =
    status === "checking"
      ? "Checking image-generation availability…"
      : "Visual preview is currently unavailable. You can still generate a reorganisation plan; only the AI-generated image will be missing.";

  const isChecking = status === "checking";

  return (
    <div className="flex items-center justify-between rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">
      <span>{message}</span>
      <button
        type="button"
        onClick={recheck}
        disabled={isChecking}
        className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
      >
        {/* Disabled, not hidden, while a check is already in flight, a
            manual recheck() call here would race the one already
            running rather than usefully do anything. Label changes so a
            disabled button isn't mistaken for a stuck/broken one. */}
        {isChecking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}
