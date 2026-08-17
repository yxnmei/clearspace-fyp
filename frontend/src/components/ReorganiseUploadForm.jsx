import { useEffect, useRef, useState } from "react";

// Presentational + its own small local UI state (selected file, context
// text, preview URL) — mirrors DeclutterUploadForm's own established
// structure, but is a SEPARATE component rather than a shared/prop-
// branching one: the accepted file types differ (PNG/JPEG only, matching
// R4's exact supported set — not "image/*"), and the copy differs. This
// keeps DeclutterUploadForm free of any Reorganise-specific knowledge,
// per this project's stated preference for not forcing Declutter
// components to understand Reorganise state.
//
// onSubmit is the only thing this component calls out to; it never talks
// to the API directly.
const ACCEPTED_TYPES = ["image/png", "image/jpeg"];

export default function ReorganiseUploadForm({ phase, error, onSubmit }) {
  const [file, setFile] = useState(null);
  const [context, setContext] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [typeError, setTypeError] = useState(null);
  const previewUrlRef = useRef(null);

  const isAnalysing = phase === "analysing";

  function handleFileChange(event) {
    const selected = event.target.files?.[0] ?? null;

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    if (selected && !ACCEPTED_TYPES.includes(selected.type)) {
      setFile(null);
      setPreviewUrl(null);
      setTypeError(`"${selected.type || "unknown"}" is not supported — please choose a PNG or JPEG photo.`);
      return;
    }

    setTypeError(null);
    setFile(selected);
    if (selected) {
      const url = URL.createObjectURL(selected);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  }

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    if (!file || isAnalysing) return;
    onSubmit({ file, context: context.trim() || null });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-medium text-stone-900">1. Upload a room photo</h2>

      <div className="mb-4">
        <label htmlFor="reorganise-image" className="mb-1 block text-sm font-medium text-stone-700">
          Room photo
        </label>
        <input
          id="reorganise-image"
          type="file"
          accept="image/png,image/jpeg"
          onChange={handleFileChange}
          disabled={isAnalysing}
          className="block w-full text-sm text-stone-700 file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-stone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        />
        <p className="mt-1 text-xs text-stone-500">PNG or JPEG of one room, photographed so most items are visible.</p>
        {typeError && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {typeError}
          </p>
        )}
      </div>

      {previewUrl && (
        <div className="mb-4">
          <img
            src={previewUrl}
            alt="Preview of the room photo you selected to reorganise"
            className="max-h-64 rounded-md border border-stone-200 object-contain"
          />
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="reorganise-context" className="mb-1 block text-sm font-medium text-stone-700">
          Context for the AI (optional)
        </label>
        <textarea
          id="reorganise-context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          disabled={isAnalysing}
          rows={2}
          placeholder="e.g. I'd like the desk to stay near the window."
          className="block w-full rounded-md border border-stone-300 p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        />
      </div>

      <button
        type="submit"
        disabled={!file || isAnalysing}
        className="rounded-md bg-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-stone-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        {isAnalysing ? "Analysing…" : "Analyse room"}
      </button>

      {isAnalysing && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-stone-600">
          <span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-green-700" />
          Analysing your room. Scene classification and object detection may take up to two minutes on this
          computer.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error} You can try again — your selected photo and context are still here.
        </p>
      )}
    </form>
  );
}
