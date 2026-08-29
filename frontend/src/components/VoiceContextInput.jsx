import { useEffect, useRef, useState } from "react";
import { useVoiceContext } from "../hooks/useVoiceContext";

// The reusable voice half of the context field, mounted beside — never
// instead of — the ordinary textarea it can fill. It is deliberately
// dumb about workflows: it knows the current context text and how to
// hand back a new one, nothing about Declutter, Reorganise or Both.
//
// The single rule this component exists to enforce: a transcript is
// NEVER written into context on arrival. It lands in a review panel the
// user can edit, apply or throw away, and only an explicit click on
// "Use as context"/"Replace context" calls onApplyTranscript.
//
// `onBusyChange` is how the host form learns to disable its own submit
// while the microphone or the transcription request is live — the
// alternative, lifting the whole hook into both forms, would duplicate
// this component's rules in two places.
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
  // also wipes the browser's own filename label. Only File.name — never
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
    <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 p-3">
      <p className="text-sm font-medium text-stone-700">Or say it instead (optional)</p>
      <p className="mt-1 text-xs text-stone-500">
        Record a short note or choose an audio file. You review the text before any of it becomes context —
        nothing is added on your behalf.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {recordingSupported &&
          (isRecording ? (
            <button
              type="button"
              onClick={stopRecording}
              disabled={disabled}
              className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
            >
              Stop recording
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartRecording}
              disabled={disabled || isBusy}
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
            >
              Record context
            </button>
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
          className="cursor-pointer rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-green-700"
        >
          Audio file
        </label>
        <span className="max-w-full truncate text-xs text-stone-600">
          {selectedFileName ?? "No audio file selected"}
        </span>
      </div>

      {!recordingSupported && (
        <p className="mt-2 text-xs text-stone-500">
          Recording is not available in this browser — choose an audio file above, or type your context below.
        </p>
      )}

      {isBusy && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-stone-700">
          <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
          {isRecording
            ? `Recording… ${elapsedSeconds}s. Keep it under a minute, then press Stop recording.`
            : "Transcribing your audio. This can take a few seconds."}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          {error}
        </p>
      )}

      {hasPendingTranscript && (
        <div className="mt-3 rounded-md border border-stone-300 bg-white p-3">
          {isPendingBlank ? (
            <>
              <p className="text-sm font-medium text-stone-800">No speech detected</p>
              <p className="mt-1 text-xs text-stone-600">
                Nothing was recognised in that audio, so there is nothing to add. Your context is unchanged.
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={handleDiscard}
                  className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
                >
                  Discard transcript
                </button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor={transcriptId} className="mb-1 block text-sm font-medium text-stone-800">
                Transcript to review
              </label>
              <textarea
                id={transcriptId}
                value={pendingTranscript}
                onChange={(event) => editPendingTranscript(event.target.value)}
                rows={3}
                className="block w-full rounded-md border border-stone-300 p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
              />
              <p className="mt-1 text-xs text-stone-500">
                {hasContext
                  ? "Applying this replaces the context you already have."
                  : "Edit it if the transcription got something wrong."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={pendingTranscript.trim().length === 0}
                  className="rounded-md bg-green-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-stone-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
                >
                  {applyLabel}
                </button>
                <button
                  type="button"
                  onClick={handleDiscard}
                  className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
                >
                  Discard transcript
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
