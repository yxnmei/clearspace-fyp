import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import RoomPhotoField from "./RoomPhotoField";
import VoiceContextInput from "./VoiceContextInput";
import { Button } from "./ui/button";

// Presentational + its own small local UI state (selected file, context
// text, preview URL), none of that is workflow state, so it stays out
// of useDeclutterFlow (§4: components stay presentational, hooks own
// real state). onSubmit is the only thing this component calls out to;
// it never talks to the API directly.
//
// The space-photo presentation is delegated to the shared, stateless
// RoomPhotoField; file state, the object-URL lifecycle and the submit
// guards stay here. The same structure is used by ReorganiseUploadForm
// (heading, copy, photo left / optional context right from lg, one
// primary action), which stays a separate component because its file
// validation and copy differ.
export default function DeclutterUploadForm({ status, error, onSubmit }) {
  const [file, setFile] = useState(null);
  const [context, setContext] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  // Owned here, reported up by VoiceContextInput: submitting while
  // the microphone or a transcription request is live would upload
  // context the user has not finished dictating.
  const [voiceBusy, setVoiceBusy] = useState(false);
  const previewUrlRef = useRef(null);

  const isUploading = status === "uploading";
  const showError = status === "error" && Boolean(error);

  function handleFileChange(event) {
    const selected = event.target.files?.[0] ?? null;

    // Revoke the previous object URL before creating a new one, object
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
    if (!file || isUploading || voiceBusy) return;
    onSubmit({ file, context: context.trim() || null });
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="declutter-upload-heading"
      className="rounded-card border border-border bg-surface shadow-card"
    >
      <div className="border-b border-border p-5 sm:p-6">
        <h2 id="declutter-upload-heading" className="text-title font-semibold tracking-tight text-foreground">
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
          id="declutter-image"
          accept="image/*"
          disabled={isUploading}
          onChange={handleFileChange}
          fileName={file?.name ?? null}
          previewUrl={previewUrl}
          previewAlt="Preview of the space photo you selected to declutter"
          helpText="JPG or PNG of one indoor space, photographed so most items are visible."
        />

        <div className="space-y-4">
          <div>
            <label htmlFor="declutter-context" className="block text-sm font-medium text-foreground">
              Context for the AI (optional)
            </label>
            <p id="declutter-context-help" className="mt-1 text-xs text-muted-foreground">
              Anything that helps the AI understand your space or what you want from it.
            </p>
            <textarea
              id="declutter-context"
              value={context}
              onChange={(event) => setContext(event.target.value)}
              disabled={isUploading}
              rows={3}
              aria-describedby="declutter-context-help"
              placeholder="e.g. I'm downsizing before a move and want to be decisive."
              className="mt-2 block w-full rounded-control border border-input bg-surface p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
            />
          </div>

          {/* Optional voice route into the SAME context field above, it
              hands back text for setContext, and never writes it itself. */}
          <VoiceContextInput
            idPrefix="declutter"
            context={context}
            onApplyTranscript={setContext}
            onBusyChange={setVoiceBusy}
            disabled={isUploading}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border p-5 sm:p-6">
        <Button
          type="submit"
          disabled={!file || isUploading || voiceBusy}
          aria-busy={isUploading || undefined}
          aria-describedby={showError ? "declutter-upload-error" : undefined}
          className="min-h-11 w-full sm:min-h-0 sm:w-auto sm:self-start"
        >
          {isUploading && <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />}
          {isUploading ? "Analysing…" : "Analyse space"}
        </Button>

        {isUploading && (
          <p role="status" className="text-sm text-muted-foreground">
            Analysing your space. This may take up to two minutes.
          </p>
        )}

        {showError && (
          <p
            id="declutter-upload-error"
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
