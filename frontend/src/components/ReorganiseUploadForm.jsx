import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import RoomPhotoField from "./RoomPhotoField";
import VoiceContextInput from "./VoiceContextInput";
import { Button } from "./ui/button";

// Owns PNG/JPEG picker validation, context state and preview cleanup;
// onSubmit is its only workflow action.
const ACCEPTED_TYPES = ["image/png", "image/jpeg"];

export default function ReorganiseUploadForm({ phase, error, onSubmit }) {
  const [file, setFile] = useState(null);
  const [context, setContext] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [typeError, setTypeError] = useState(null);
  // Block submit while voice input is unfinished.
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
          Upload one clear photo with most items in frame. Context is optional.
        </p>
      </div>

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

          {/* Voice fills context only after explicit apply. */}
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
          className="min-h-11 self-end sm:min-h-0"
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
