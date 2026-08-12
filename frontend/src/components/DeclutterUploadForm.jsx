import { useEffect, useRef, useState } from "react";

// Presentational + its own small local UI state (selected file, context
// text, preview URL) — none of that is workflow state, so it stays out
// of useDeclutterFlow (§4: components stay presentational, hooks own
// real state). onSubmit is the only thing this component calls out to;
// it never talks to the API directly.
export default function DeclutterUploadForm({ status, error, onSubmit }) {
  const [file, setFile] = useState(null);
  const [context, setContext] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const previewUrlRef = useRef(null);

  const isUploading = status === "uploading";

  function handleFileChange(event) {
    const selected = event.target.files?.[0] ?? null;

    // Revoke the previous object URL before creating a new one — object
    // URLs are only released by an explicit revoke, never automatically.
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setFile(selected);
    if (selected) {
      const url = URL.createObjectURL(selected);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  }

  // Clean up the last object URL if the component unmounts with one
  // still outstanding (e.g. navigating away mid-review).
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    if (!file || isUploading) return;
    onSubmit({ file, context: context.trim() || null });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-medium text-stone-900">1. Upload a room photo</h2>

      <div className="mb-4">
        <label htmlFor="declutter-image" className="mb-1 block text-sm font-medium text-stone-700">
          Room photo
        </label>
        <input
          id="declutter-image"
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          disabled={isUploading}
          className="block w-full text-sm text-stone-700 file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-stone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        />
        <p className="mt-1 text-xs text-stone-500">JPG or PNG of one room, photographed so most items are visible.</p>
      </div>

      {previewUrl && (
        <div className="mb-4">
          <img
            src={previewUrl}
            alt="Preview of the room photo you selected to declutter"
            className="max-h-64 rounded-md border border-stone-200 object-contain"
          />
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="declutter-context" className="mb-1 block text-sm font-medium text-stone-700">
          Context for the AI (optional)
        </label>
        <textarea
          id="declutter-context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          disabled={isUploading}
          rows={2}
          placeholder="e.g. I'm downsizing before a move and want to be decisive."
          className="block w-full rounded-md border border-stone-300 p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        />
      </div>

      <button
        type="submit"
        disabled={!file || isUploading}
        className="rounded-md bg-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-stone-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        {isUploading ? "Analysing…" : "Analyse room"}
      </button>

      {isUploading && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-stone-600">
          <span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-green-700" />
          Analysing your room. Scene classification, object detection and item reasoning may take up to two minutes
          on this computer.
        </p>
      )}

      {status === "error" && error && (
        <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error} You can try again — your selected photo and context are still here.
        </p>
      )}
    </form>
  );
}
