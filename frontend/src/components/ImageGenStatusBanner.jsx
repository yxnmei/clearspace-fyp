import { useImageGenHealth } from "../hooks/useImageGenHealth";

// §5: surfaces Colab/ngrok status in the UI itself, rather than only
// failing once someone clicks Reorganise. Presentational — all the
// polling/state logic lives in useImageGenHealth (§4: components stay
// presentational only).
export default function ImageGenStatusBanner() {
  const { status, recheck } = useImageGenHealth();

  if (status === "available") return null; // don't clutter the UI when everything's fine

  const message =
    status === "checking"
      ? "Checking image-generation availability…"
      : "Image generation unavailable — start the Colab notebook and check the ngrok tunnel.";

  return (
    <div className="flex items-center justify-between rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">
      <span>{message}</span>
      <button onClick={recheck} className="underline">
        Check again
      </button>
    </div>
  );
}
