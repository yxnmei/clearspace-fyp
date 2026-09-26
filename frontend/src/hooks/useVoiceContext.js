import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio } from "../api/client";
import { normaliseTranscriptionResponse } from "../api/transcriptionContract";

// Voice produces a pending transcript only. Applying it to context remains
// an explicit user action owned by VoiceContextInput.

// Preferred browser-supported types within the backend allowlist.
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

// Reject unsupported files before upload.
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

// Fixed display-safe messages never expose response bodies or backend details.
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

// Recording requires both MediaRecorder and getUserMedia.
export function canRecordAudio() {
  if (typeof window === "undefined") return false;
  if (typeof window.MediaRecorder !== "function") return false;
  const mediaDevices = typeof navigator === "undefined" ? null : navigator.mediaDevices;
  return Boolean(mediaDevices) && typeof mediaDevices.getUserMedia === "function";
}

function pickMimeType() {
  const isTypeSupported = window.MediaRecorder?.isTypeSupported;
  if (typeof isTypeSupported !== "function") return null;
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (window.MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

// ApiError status/detail route to fixed messages only; neither is displayed.
function messageForError(error) {
  const status = Number(error?.status);
  const detail = typeof error?.detail === "string" ? error.detail.toLowerCase() : "";

  if (status === 415 || status === 400) return VOICE_MESSAGES.unsupportedAudio;
  if (status === 413) return VOICE_MESSAGES.tooLong;
  if (status === 503) {
    return detail.includes("transcription is busy") ? VOICE_MESSAGES.busy : VOICE_MESSAGES.unavailable;
  }
  return VOICE_MESSAGES.failed;
}

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // An already-ended track must not break teardown.
    }
  }
}

export function useVoiceContext() {
  const [status, setStatus] = useState("idle");
  const [pendingTranscript, setPendingTranscript] = useState(null);
  // Server-reported silence differs from a user clearing the review text.
  const [pendingIsSilent, setPendingIsSilent] = useState(false);
  const [error, setError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingSupported, setRecordingSupported] = useState(() => canRecordAudio());

  // Latch synchronously; state alone lets a double click pass before await.
  const busyRef = useRef(false);
  // Operation tokens block late continuations after replacement or discard.
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

  // Every exit path shares this microphone and timer teardown.
  const releaseRecording = useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already torn down.
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
      operationRef.current += 1;
      busyRef.current = false;
      releaseRecording();
    };
  }, [releaseRecording]);

  const runTranscription = useCallback(async (blob, token) => {
    if (mountedRef.current && token === operationRef.current) {
      setStatus("transcribing");
    }

    let response;
    try {
      response = await transcribeAudio({ audioBlob: blob });
    } catch (caught) {
      // A stale rejection must not unlock its replacement.
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

    // Only a valid response may represent server-reported silence.
    let validated;
    try {
      validated = normaliseTranscriptionResponse(response);
    } catch {
      // Keep contract diagnostics out of the UI.
      setStatus("idle");
      setError(VOICE_MESSAGES.failed);
      return;
    }

    const transcript = validated.transcript.trim();
    // Explicit "" is valid silence and cannot be applied as context.
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

    // Release permission granted after discard or unmount.
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

    // MediaRecorder may emit error -> dataavailable -> stop. Mark the take
    // terminal so the trailing events cannot start transcription.
    let takeFailed = false;

    // Release only this take, never a later recorder now held by the refs.
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
      if (takeFailed) return;
      takeFailed = true;

      const isCurrentOperation = token === operationRef.current;
      releaseThisTake();
      if (!isCurrentOperation) return;

      // Invalidate every trailing continuation of this failed take.
      operationRef.current += 1;
      busyRef.current = false;
      if (!mountedRef.current) return;
      setStatus("idle");
      setError(VOICE_MESSAGES.microphoneUnavailable);
    };

    recorder.onstop = () => {
      if (takeFailed) {
        // The take was already released and reported.
        releaseThisTake();
        return;
      }

      const chunks = chunksRef.current;
      // Use the recorder's actual type, which may differ from the request.
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
      recorder.stop();
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

  // Pending edits remain local until explicitly applied.
  const editPendingTranscript = useCallback((text) => {
    setPendingTranscript(typeof text === "string" ? text : "");
  }, []);

  // Discard invalidates in-flight work before clearing local state.
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
