// Pure functions only, unit-tested (§4), no React/DOM/fetch here. Same
// convention as declutterContract.js / confirmationContract.js /
// reorganiseContract.js, including the deliberate duplication of the
// small local helpers below rather than sharing a helpers module.
//
// One job: normaliseTranscriptionResponse(), validates POST
// /transcribe's response (see app/api/routes.py's TranscribeResponse)
// before anything reads a transcript out of it.
//
// The distinction this module exists to protect is narrow and easy to
// lose: an EMPTY transcript is a legitimate result (a silent recording),
// but only when the server actually said so by returning
// `transcript: ""` inside an otherwise complete, well-formed response. A
// response missing the field, carrying the wrong type, or carrying
// fields the contract does not define is MALFORMED, it is not evidence
// of silence, and treating it as such would tell the user "no speech
// detected" about a response that never described any speech at all.
//
// Mirrors TranscribeResponse's own `extra="forbid"` on the wire: an
// unrecognised field means the client and server disagree about the
// contract, which is a defect to surface, not a field to ignore.
//
// Nothing here coerces. A numeric string is not a number, `1` is not
// `true`, and no value is trimmed, rounded or defaulted, the caller
// gets exactly what the server sent, or an error.

const EXPECTED_FIELDS = ["transcript", "model_name", "transcription_ms", "audio_duration_s"];
const EXPECTED_FIELD_SET = new Set(EXPECTED_FIELDS);

function fail(message) {
  throw new Error(`transcriptionContract: ${message}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deliberately NOT requireNonEmptyString: "" is the contract's own
// representation of a silent recording.
function requireString(value, name) {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value;
}

// typeof rejects booleans before Number.isFinite ever runs (typeof true
// is "boolean"), so `true` cannot slip through as 1, the same trap
// TranscribeResponse's own validator calls out on the server side.
function requireNonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  if (value < 0) fail(`${name} must not be negative`);
  return value;
}

/**
 * Validate one POST /transcribe response.
 *
 * @param {unknown} response
 * @returns {{ transcript: string, modelName: string, transcriptionMs: number, audioDurationS: number }}
 * @throws {Error} on anything that is not exactly the four-field contract.
 */
export function normaliseTranscriptionResponse(response) {
  if (!isPlainObject(response)) fail("response must be an object");

  const unexpected = Object.keys(response).filter((key) => !EXPECTED_FIELD_SET.has(key));
  if (unexpected.length > 0) {
    fail(`unexpected field(s): ${JSON.stringify(unexpected.sort())}`);
  }

  const transcript = requireString(response.transcript, "transcript");
  const modelName = requireNonEmptyString(response.model_name, "model_name");
  // Inference wall-clock and decoded audio length respectively, kept
  // apart on the server precisely so the V3 comparison can read them
  // separately, so neither is allowed to stand in for the other here.
  const transcriptionMs = requireNonNegativeNumber(response.transcription_ms, "transcription_ms");
  const audioDurationS = requireNonNegativeNumber(response.audio_duration_s, "audio_duration_s");

  return { transcript, modelName, transcriptionMs, audioDurationS };
}
