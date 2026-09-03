import { useEffect, useRef, useState } from "react";
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
// The room-photo presentation is delegated to the shared, stateless
// RoomPhotoField; the PNG/JPEG type check, file state, the object-URL
// lifecycle and the submit guards stay here.
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
    <form onSubmit={handleSubmit} className="rounded-card border border-border bg-surface shadow-card">
      <div className="border-b border-border p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-foreground">1. Upload a room photo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One clear photo of the room, with most items in frame. You can add optional context for the AI too.
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
          previewAlt="Preview of the room photo you selected to reorganise"
          helpText="PNG or JPEG of one room, photographed so most items are visible."
          error={typeError}
        />

        <div className="space-y-4">
          <div>
            <label htmlFor="reorganise-context" className="block text-sm font-medium text-foreground">
              Context for the AI (optional)
            </label>
            <textarea
              id="reorganise-context"
              value={context}
              onChange={(event) => setContext(event.target.value)}
              disabled={isAnalysing}
              rows={3}
              placeholder="e.g. I'd like the desk to stay near the window."
              className="mt-1 block w-full rounded-control border border-input bg-surface p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
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
        <Button type="submit" disabled={!file || isAnalysing || voiceBusy} className="self-start">
          {isAnalysing ? "Analysing…" : "Analyse room"}
        </Button>

        {isAnalysing && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-pill bg-primary" />
            Analysing your room. Scene classification and object detection may take up to two minutes on this
            computer.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error">
            {error} You can try again. Your selected photo and context are still here.
          </p>
        )}
      </div>
    </form>
  );
}
