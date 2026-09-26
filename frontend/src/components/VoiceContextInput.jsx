import { useEffect, useRef, useState } from "react";
import { Check, FileAudio, Mic, MicOff, Square, Trash2, TriangleAlert } from "lucide-react";
import { useVoiceContext } from "../hooks/useVoiceContext";
import { Button, buttonVariants } from "./ui/button";
import { cn } from "../lib/cn";

// Workflow-agnostic voice review. Transcripts never enter context on arrival;
// only explicit apply calls onApplyTranscript. Busy state disables host submit.
export default function VoiceContextInput({
  idPrefix,
  context = "",
  onApplyTranscript,
  onBusyChange,
  disabled = false,
}) {
  const {
    isBusy,
    isRecording,
    isTranscribing,
    recordingSupported,
    elapsedSeconds,
    pendingTranscript,
    hasPendingTranscript,
    isPendingBlank,
    error,
    startRecording,
    stopRecording,
    transcribeFile,
    editPendingTranscript,
    discard,
  } = useVoiceContext();

  // Stabilise busy notifications even when the host passes an inline callback.
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });

  useEffect(() => {
    onBusyChangeRef.current?.(isBusy);
  }, [isBusy]);

  // Unmount must release the host's disabled state.
  useEffect(() => {
    return () => onBusyChangeRef.current?.(false);
  }, []);

  // Retain File.name because the native value is cleared for same-file retry.
  const [selectedFileName, setSelectedFileName] = useState(null);

  const audioInputId = `${idPrefix}-voice-file`;
  const transcriptId = `${idPrefix}-voice-transcript`;
  const hasContext = context.trim().length > 0;
  const applyLabel = hasContext ? "Replace context" : "Use as context";

  async function handleFileChange(event) {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    // Clearing allows the same file to fire change again after failure.
    input.value = "";
    if (!file) return;
    // Keep the selected name visible on failure.
    setSelectedFileName(file.name);
    await transcribeFile(file);
  }

  // Clear the filename only when leaving that file's flow.
  function handleApply() {
    const text = (pendingTranscript ?? "").trim();
    if (!text) return;
    onApplyTranscript?.(text);
    setSelectedFileName(null);
    discard();
  }

  function handleDiscard() {
    setSelectedFileName(null);
    discard();
  }

  function handleStartRecording() {
    setSelectedFileName(null);
    return startRecording();
  }

  return (
    <div className="rounded-card border border-border bg-surface-muted p-4">
      <p className="text-sm font-medium text-foreground">Or say it instead (optional)</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Record a short note or choose an audio file. You review the text before any of it becomes context,
        nothing is added on your behalf.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {recordingSupported &&
          (isRecording ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={stopRecording}
              disabled={disabled}
              className="border-error/40 text-error hover:bg-error/10 hover:text-error"
            >
              <Square aria-hidden="true" width={14} height={14} />
              Stop recording
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleStartRecording}
              disabled={disabled || isBusy}
            >
              <Mic aria-hidden="true" width={14} height={14} />
              Record context
            </Button>
          ))}

        {/* Keep the labelled native input focusable behind the styled control. */}
        <input
          id={audioInputId}
          type="file"
          accept="audio/*"
          onChange={handleFileChange}
          disabled={disabled || isBusy}
          className="peer sr-only"
        />
        <label
          htmlFor={audioInputId}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "cursor-pointer",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            "peer-disabled:pointer-events-none peer-disabled:opacity-50"
          )}
        >
          <FileAudio aria-hidden="true" width={14} height={14} />
          Audio file
        </label>
        <span className="max-w-full truncate text-xs text-muted-foreground">
          {selectedFileName ?? "No audio file selected"}
        </span>
      </div>

      {!recordingSupported && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <MicOff aria-hidden="true" width={13} height={13} />
          Recording is not available in this browser. Choose an audio file above, or type your context below.
        </p>
      )}

      {isBusy && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-foreground">
          <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-pill bg-error" />
          {isRecording
            ? `Recording… ${elapsedSeconds}s. Keep it under a minute, then press Stop recording.`
            : "Transcribing your audio. This can take a few seconds."}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-control border border-warning/40 bg-warning/10 p-2 text-sm text-warning-foreground"
        >
          <TriangleAlert aria-hidden="true" width={15} height={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {hasPendingTranscript && (
        <div className="mt-3 rounded-control border border-border bg-surface p-3">
          {isPendingBlank ? (
            <>
              <p className="text-sm font-medium text-foreground">No speech detected</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing was recognised in that audio, so there is nothing to add. Your context is unchanged.
              </p>
              <div className="mt-3">
                <Button type="button" variant="outline" size="sm" onClick={handleDiscard}>
                  <Trash2 aria-hidden="true" width={14} height={14} />
                  Discard transcript
                </Button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor={transcriptId} className="mb-1 block text-sm font-medium text-foreground">
                Transcript to review
              </label>
              <textarea
                id={transcriptId}
                value={pendingTranscript}
                onChange={(event) => editPendingTranscript(event.target.value)}
                rows={3}
                className="block w-full rounded-control border border-input bg-surface p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {hasContext
                  ? "Applying this replaces the context you already have."
                  : "Edit it if the transcription got something wrong."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleApply}
                  disabled={pendingTranscript.trim().length === 0}
                >
                  <Check aria-hidden="true" width={14} height={14} />
                  {applyLabel}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleDiscard}>
                  <Trash2 aria-hidden="true" width={14} height={14} />
                  Discard transcript
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
