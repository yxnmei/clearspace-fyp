import { useEffect, useRef, useState } from "react";
import { Check, FileAudio, Mic, MicOff, Square, Trash2, TriangleAlert } from "lucide-react";
import { useVoiceContext } from "../hooks/useVoiceContext";
import { Button, buttonVariants } from "./ui/button";
import { cn } from "../lib/cn";

// The reusable voice half of the context field, mounted beside, never
// instead of, the ordinary textarea it can fill. It is deliberately
// dumb about workflows: it knows the current context text and how to
// hand back a new one, nothing about Declutter, Reorganise or Both.
//
// The single rule this component exists to enforce: a transcript is
// NEVER written into context on arrival. It lands in a review panel the
// user can edit, apply or throw away, and only an explicit click on
// "Use as context"/"Replace context" calls onApplyTranscript.
//
// `onBusyChange` is how the host form learns to disable its own submit
// while the microphone or the transcription request is live, the
// alternative, lifting the whole hook into both forms, would duplicate
// this component's rules in two places.
//
// Phase 2 restyled this panel onto the ClearSpace design system; the
// concurrency latch, operation token, microphone cleanup and
// transcript-review flow all still live in useVoiceContext, untouched.
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

  // Held in a ref so the two effects below depend on `isBusy` alone. A
  // host passing an inline arrow would otherwise change the callback's
  // identity every render, and the unmount effect's cleanup would fire
  // on each of them, fighting the notify effect.
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });

  useEffect(() => {
    onBusyChangeRef.current?.(isBusy);
  }, [isBusy]);

  // Report idle on the way out, so unmounting mid-recording cannot
  // leave the host form's submit button disabled forever.
  useEffect(() => {
    return () => onBusyChangeRef.current?.(false);
  }, []);

  // The chosen file's NAME, kept here because the native input cannot:
  // handleFileChange clears input.value immediately (see below), which
  // also wipes the browser's own filename label. Only File.name, never
  // a path, which the browser does not expose anyway.
  const [selectedFileName, setSelectedFileName] = useState(null);

  const audioInputId = `${idPrefix}-voice-file`;
  const transcriptId = `${idPrefix}-voice-transcript`;
  const hasContext = context.trim().length > 0;
  const applyLabel = hasContext ? "Replace context" : "Use as context";

  async function handleFileChange(event) {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    // Clear the input so choosing the SAME file again after a failure
    // still fires a change event. This is why the name is held in state
    // rather than read back off the input.
    input.value = "";
    if (!file) return;
    // Set before transcribing and kept on failure: a rejected file is
    // when the user most needs to see which one they picked.
    setSelectedFileName(file.name);
    await transcribeFile(file);
  }

  // Apply, discard and record-instead are the three moments the chosen
  // file stops being what the panel is about; every other state keeps
  // the name on screen.
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

        {/* The real input is kept and only its native rendering is
            replaced: visually hidden, so it stays focusable and
            labelled, with `peer` carrying focus and disabled onto the
            label. Hiding it is what stops the browser's own "No file
            chosen" contradicting the retained filename beside it. */}
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
