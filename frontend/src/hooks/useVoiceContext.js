import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio } from "../api/client";
import { normaliseTranscriptionResponse } from "../api/transcriptionContract";

// Voice is an OPTIONAL way to populate the existing `user_context`
// field, never a command channel, and never an automatic writer. This
// hook owns the whole recording/transcription lifecycle and produces a
// *pending* transcript; whether that text ever becomes context is the
// user's decision, made explicitly in VoiceContextInput. Nothing here
// touches the caller's context state.
//
// Mirrors the backend's own framing (POST /transcribe returns a
// transcript and nothing else: no run, no analysis, no correlation).

// Ordered by preference, filtered through MediaRecorder.isTypeSupported
// the browser is asked what it supports rather than assumed to be
// Chrome. Every candidate is inside the backend's accepted set (see
// app/core/audio_decode.py); codec parameters are stripped server-side,
// so "audio/webm;codecs=opus" is validated as "audio/webm".
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

// Client-side mirror of the backend allowlist, so an obviously wrong
// file fails immediately and locally instead of costing an upload and
// coming back as a sanitised 415.
const ACCEPTED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
]);

// Concise, optional-feature wording: every message says what the user
// can do next, and none of them leaks a status code, a response body or
// a backend detail string. Exported so tests assert against the same
// constants the UI renders rather than duplicated literals.
export const VOICE_MESSAGES = {
  unsupportedAudio: "That audio could not be read. Record again, or choose a different audio file.",
  tooLong: "That recording is too long. Record a shorter clip and try again.",
  busy: "Voice transcription is busy right now. Wait a few seconds and try again.",
  unavailable: "Voice transcription is unavailable right now. You can still type your context below.",
  failed: "Voice input did not work. Your typed context is unchanged. You can try again.",
  permissionDenied:
    "Microphone access was blocked. You can upload an audio file instead, or just type your context.",
  microphoneUnavailable:
    "The microphone could not be started. You can upload an audio file instead, or just type your context.",
  recordingUnsupported:
    "Recording is not supported in this browser. You can upload an audio file instead, or just type your context.",
  emptyRecording: "No audio was captured. Record again, or choose an audio file.",
};

function stripParameters(mediaType) {
  return String(mediaType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

// Both halves are required: a browser with MediaRecorder but no
// getUserMedia (or an insecure origin, where mediaDevices is absent)
// cannot record, and must fall through to the file/typed fallbacks.
export function canRecordAudio() {
  if (typeof window === "undefined") return false;
  if (typeof window.MediaRecorder !== "function") return false;
  const mediaDevices = typeof navigator === "undefined" ? null : navigator.mediaDevices;
  return Boolean(mediaDevices) && typeof mediaDevices.getUserMedia === "function";
}

function pickMimeType() {
  const isTypeSupported = window.MediaRecorder?.isTypeSupported;
  if (typeof isTypeSupported !== "function") return null; // let the browser choose
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (window.MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

// api/client.js's request() throws `${method} ${path} failed: ${status}
// ${body}`, so the status and the backend's own detail are readable
// here, for ROUTING only. Neither is ever returned: every branch below
// resolves to one of the fixed VOICE_MESSAGES strings.
function messageForError(error) {
  const raw = typeof error?.message === "string" ? error.message : "";
  const status = Number(raw.match(/failed:\s*(\d{3})\b/)?.[1]);

  if (status === 415 || status === 400) return VOICE_MESSAGES.unsupportedAudio;
  if (status === 413) return VOICE_MESSAGES.tooLong;
  if (status === 503) {
    return raw.includes("transcription is busy") ? VOICE_MESSAGES.busy : VOICE_MESSAGES.unavailable;
  }
  return VOICE_MESSAGES.failed;
}

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track the browser already ended must not break teardown.
    }
  }
}

export function useVoiceContext() {
  const [status, setStatus] = useState("idle"); // idle | starting | recording | transcribing
  const [pendingTranscript, setPendingTranscript] = useState(null);
  // Whether the MODEL returned nothing, deliberately separate from
  // "the pending text is empty right now". A user who clears the review
  // box has not been told there was no speech; they are mid-edit, and
  // the editable panel must stay open for them.
  const [pendingIsSilent, setPendingIsSilent] = useState(false);
  const [error, setError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingSupported, setRecordingSupported] = useState(() => canRecordAudio());

  // One operation at a time, latched synchronously: getUserMedia is
  // async, so a state flag would let a double click through before the
  // first await ever resolved.
  const busyRef = useRef(false);
  // Bumped by every new operation, by discard() and on unmount. Async
  // continuations capture the value at their start and write state only
  // while it still matches, so a late response belonging to an
  // abandoned operation can never revive itself.
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Every exit path, normal stop, recorder error, permission failure,
  // discard and unmount, funnels through here, so there is exactly one
  // place that releases the microphone and the timer.
  const releaseRecording = useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already torn down by the browser.
      }
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    chunksRef.current = [];
  }, [clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1; // invalidate anything still in flight
      busyRef.current = false;
      releaseRecording();
    };
  }, [releaseRecording]);

  // This hook creates no object URLs, the pending transcript is text,
  // and recorded audio is never played back, so there is deliberately
  // nothing to revoke. The interval above is the only timer it owns.

  const runTranscription = useCallback(async (blob, token) => {
    if (mountedRef.current && token === operationRef.current) {
      setStatus("transcribing");
    }

    let response;
    try {
      response = await transcribeAudio({ audioBlob: blob });
    } catch (caught) {
      // Only the CURRENT operation may release the busy latch: a stale
      // rejection must not unlock work that has since replaced it.
      if (token !== operationRef.current) return;
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(messageForError(caught));
      return;
    }

    if (token !== operationRef.current) return;
    busyRef.current = false;
    if (!mountedRef.current) return;

    // A 200 is not proof of a usable body. Validating here is what keeps
    // "the server said the recording was silent" separate from "the
    // server sent something this client cannot read": only the first is
    // allowed to become a pending transcript at all.
    let validated;
    try {
      validated = normaliseTranscriptionResponse(response);
    } catch {
      // The thrown message names fields and values, diagnostic detail
      // that must not reach the UI. It is deliberately swallowed in
      // favour of the fixed generic message.
      setStatus("idle");
      setError(VOICE_MESSAGES.failed);
      return;
    }

    const transcript = validated.transcript.trim();
    // "" is a legitimate result, a silent recording, not an error, and
    // now only reachable when the server explicitly said so. It becomes
    // a visible "No speech detected" panel that cannot be applied,
    // rather than blank text quietly offered as context.
    setPendingTranscript(transcript);
    setPendingIsSilent(transcript === "");
    setStatus("idle");
  }, []);

  const startRecording = useCallback(async () => {
    if (busyRef.current) {
      setError(VOICE_MESSAGES.busy);
      return;
    }
    if (!canRecordAudio()) {
      setRecordingSupported(false);
      setError(VOICE_MESSAGES.recordingUnsupported);
      return;
    }

    busyRef.current = true;
    const token = (operationRef.current += 1);
    setRecordingSupported(true);
    setError(null);
    setPendingTranscript(null);
    setPendingIsSilent(false);
    setElapsedSeconds(0);
    setStatus("starting");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (caught) {
      if (token !== operationRef.current) return;
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(
        caught?.name === "NotAllowedError" || caught?.name === "SecurityError"
          ? VOICE_MESSAGES.permissionDenied
          : VOICE_MESSAGES.microphoneUnavailable,
      );
      return;
    }

    // Permission can land after the user discarded or navigated away,
    // the tracks that were just granted still have to be released.
    if (token !== operationRef.current || !mountedRef.current) {
      stopStream(stream);
      return;
    }

    const mimeType = pickMimeType();
    let recorder;
    try {
      recorder = mimeType
        ? new window.MediaRecorder(stream, { mimeType })
        : new window.MediaRecorder(stream);
    } catch {
      stopStream(stream);
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(VOICE_MESSAGES.microphoneUnavailable);
      return;
    }

    chunksRef.current = [];
    streamRef.current = stream;
    recorderRef.current = recorder;

    // A recorder error is TERMINAL for this take. The MediaRecorder
    // specification permits error -> dataavailable -> stop, so the
    // handlers below all run again after a failure; without this flag
    // the trailing stop would build a blob from post-failure chunks and
    // start a transcription for a take that already reported an error.
    let takeFailed = false;

    // Releases THIS take only. If the refs have already moved on, a
    // discard, an unmount, or a later take, they are left alone: the
    // path that moved them already stopped this stream, and tearing
    // down again here would either double-stop these tracks or stop a
    // microphone the user is currently recording into.
    const releaseThisTake = () => {
      if (recorderRef.current !== recorder) return;
      releaseRecording();
    };

    recorder.ondataavailable = (event) => {
      if (takeFailed) return;
      const data = event?.data;
      if (data && (data.size ?? 0) > 0) chunksRef.current.push(data);
    };

    recorder.onerror = () => {
      if (takeFailed) return; // one error per take, whatever the browser sends
      takeFailed = true;

      const isCurrentOperation = token === operationRef.current;
      releaseThisTake();
      if (!isCurrentOperation) return;

      // Invalidating the token is what makes the failure terminal
      // rather than merely reported: every later continuation of this
      // take, the trailing stop event, and any transcription it might
      // otherwise have started, now fails its own token check, so
      // nothing can overwrite the message set just below.
      operationRef.current += 1;
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(VOICE_MESSAGES.microphoneUnavailable);
    };

    recorder.onstop = () => {
      if (takeFailed) {
        // The spec-permitted stop after an error. The take is already
        // released and reported; there is nothing left to do.
        releaseThisTake();
        return;
      }

      const chunks = chunksRef.current;
      // The blob is typed with what the recorder actually settled on,
      // not with what we asked for, the two can differ.
      const type = stripParameters(recorder.mimeType || mimeType || "audio/webm");
      releaseThisTake();

      if (token !== operationRef.current) return;

      if (chunks.length === 0) {
        busyRef.current = false;
        if (!mountedRef.current) return;
        setStatus("idle");
        setError(VOICE_MESSAGES.emptyRecording);
        return;
      }

      // Every chunk collected during the take, joined into ONE Blob.
      const blob = new Blob(chunks, { type });
      if (!mountedRef.current) {
        busyRef.current = false;
        return;
      }
      void runTranscription(blob, token);
    };

    try {
      recorder.start();
    } catch {
      releaseThisTake();
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(VOICE_MESSAGES.microphoneUnavailable);
      return;
    }

    setStatus("recording");
    clearTimer();
    timerRef.current = setInterval(() => {
      setElapsedSeconds((previous) => previous + 1);
    }, 1000);
  }, [clearTimer, releaseRecording, runTranscription]);

  const stopRecording = useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop(); // onstop builds the Blob and starts transcription
    } catch {
      releaseRecording();
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(VOICE_MESSAGES.microphoneUnavailable);
    }
  }, [clearTimer, releaseRecording]);

  const transcribeFile = useCallback(
    async (file) => {
      if (!file) return;
      if (busyRef.current) {
        setError(VOICE_MESSAGES.busy);
        return;
      }
      if (!ACCEPTED_AUDIO_TYPES.has(stripParameters(file.type))) {
        setError(VOICE_MESSAGES.unsupportedAudio);
        return;
      }

      busyRef.current = true;
      const token = (operationRef.current += 1);
      setError(null);
      setPendingTranscript(null);
      setPendingIsSilent(false);
      setElapsedSeconds(0);
      await runTranscription(file, token);
    },
    [runTranscription],
  );

  // Editing the pending transcript before applying it is the point of
  // the review step; it stays entirely local until the caller applies it.
  const editPendingTranscript = useCallback((text) => {
    setPendingTranscript(typeof text === "string" ? text : "");
  }, []);

  // Abandons whatever voice work exists: the pending transcript, any
  // error, and any in-flight operation, whose response is invalidated
  // by the token bump and can no longer write state.
  const discard = useCallback(() => {
    operationRef.current += 1;
    busyRef.current = false;
    releaseRecording();
    setStatus("idle");
    setPendingTranscript(null);
    setPendingIsSilent(false);
    setElapsedSeconds(0);
    setError(null);
  }, [releaseRecording]);

  const isRecording = status === "recording" || status === "starting";
  const isTranscribing = status === "transcribing";

  return {
    status,
    isBusy: isRecording || isTranscribing,
    isRecording,
    isTranscribing,
    recordingSupported,
    elapsedSeconds,
    pendingTranscript,
    hasPendingTranscript: pendingTranscript !== null,
    isPendingBlank: pendingIsSilent,
    error,
    startRecording,
    stopRecording,
    transcribeFile,
    editPendingTranscript,
    discard,
  };
}
