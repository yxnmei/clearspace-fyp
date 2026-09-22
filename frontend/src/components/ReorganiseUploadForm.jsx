import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import RoomPhotoField from "./RoomPhotoField";
import VoiceContextInput from "./VoiceContextInput";
import { Button } from "./ui/button";

// Presentational + its own small local UI state (selected file, context
// text, preview URL), mirrors DeclutterUploadForm's own established
// structure, but is a SEPARATE component rather than a shared/prop-
// branching one: the accepted file types differ (PNG/JPEG only, matching
// R4's exact supported set, not "image/*"), and the copy differs. This
// keeps DeclutterUploadForm free of any Reorganise-specific knowledge,
// per this project's stated preference for not forcing Declutter
// components to understand Reorganise state.
//
// The space-photo presentation is delegated to the shared, stateless
// RoomPhotoField; the PNG/JPEG type check, file state, the object-URL
// lifecycle and the submit guards stay here. The visible structure
// (heading, copy, photo left / optional context right from lg, one
// primary action) is the same as DeclutterUploadForm's on purpose.
//
// onSubmit is the only thing this component calls out to; it never talks
// to the API directly.
const ACCEPTED_TYPES = ["image/png", "image/jpeg"];

export default function ReorganiseUploadForm({ phase, error, onSubmit }) {
  const [file, setFile] = useState(null);
  const [context, setContext] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [typeError, setTypeError] = useState(null);
  // Same reasoning as DeclutterUploadForm's own voiceBusy: an upload
  // must not start while the microphone or a transcription is live.
  const [voiceBusy, setVoiceBusy] = useState(false);
  const previewUrlRef = useRef(null);

  const isAnalysing = phase === "analysing";
  const showError = Boolean(error);

  function handleFileChange(event) {
    const selected = event.target.files?.[0] ?? null;

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    if (selected && !ACCEPTED_TYPES.includes(selected.type)) {
      setFile(null);
      setPreviewUrl(null);
      setTypeError(`"${selected.type || "unknown"}" is not supported. Please choose a PNG or JPEG photo.`);
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
    if (!file || isAnalysing || voiceBusy) return;
    onSubmit({ file, context: context.trim() || null });
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="reorganise-upload-heading"
      className="rounded-card border border-border bg-surface shadow-card"
    >
      <div className="border-b border-border p-5 sm:p-6">
        <h2 id="reorganise-upload-heading" className="text-title font-semibold tracking-tight text-foreground">
          Upload a photo of your space
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Upload one clear photo of your space, with most items in frame. You can also provide optional context to
          help the AI better understand your space.
        </p>
      </div>

      {/* Photo first (the primary task), optional context second; a
          balanced two-column composition from lg, one column below. */}
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-2">
        <RoomPhotoField
          id="reorganise-image"
          accept="image/png,image/jpeg"
          disabled={isAnalysing}
          onChange={handleFileChange}
          fileName={file?.name ?? null}
          previewUrl={previewUrl}
          previewAlt="Preview of the space photo you selected to reorganise"
          helpText="PNG or JPEG of one indoor space, photographed so most items are visible."
          error={typeError}
        />

        <div className="space-y-4">
          <div>
            <label htmlFor="reorganise-context" className="block text-sm font-medium text-foreground">
              Context for the AI (optional)
            </label>
            <p id="reorganise-context-help" className="mt-1 text-xs text-muted-foreground">
              Anything that helps the AI understand your space or how you want it arranged.
            </p>
            <textarea
              id="reorganise-context"
              value={context}
              onChange={(event) => setContext(event.target.value)}
              disabled={isAnalysing}
              rows={3}
              aria-describedby="reorganise-context-help"
              placeholder="e.g. I'd like the desk to stay near the window."
              className="mt-2 block w-full rounded-control border border-input bg-surface p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
            />
          </div>

          {/* The same reusable voice UI DeclutterUploadForm mounts, it
              fills the context field above only when the user applies it. */}
          <VoiceContextInput
            idPrefix="reorganise"
            context={context}
            onApplyTranscript={setContext}
            onBusyChange={setVoiceBusy}
            disabled={isAnalysing}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border p-5 sm:p-6">
        <Button
          type="submit"
          disabled={!file || isAnalysing || voiceBusy}
          aria-busy={isAnalysing || undefined}
          aria-describedby={showError ? "reorganise-upload-error" : undefined}
          className="min-h-11 w-full sm:min-h-0 sm:w-auto sm:self-start"
        >
          {isAnalysing && <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />}
          {isAnalysing ? "Analysing…" : "Analyse space"}
        </Button>

        {isAnalysing && (
          <p role="status" className="text-sm text-muted-foreground">
            Analysing your space. This may take up to two minutes.
          </p>
        )}

        {showError && (
          <p
            id="reorganise-upload-error"
            role="alert"
            className="rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
          >
            {error} You can try again. Your selected photo and context are still here.
          </p>
        )}
      </div>
    </form>
  );
}
