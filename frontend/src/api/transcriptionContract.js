// An empty transcript is valid only when the server explicitly returns ""
// in an otherwise exact response. Missing, extra or mistyped fields are not
// evidence of silence. Values are never coerced or defaulted.

const EXPECTED_FIELDS = ["transcript", "model_name", "transcription_ms", "audio_duration_s"];
const EXPECTED_FIELD_SET = new Set(EXPECTED_FIELDS);

function fail(message) {
  throw new Error(`transcriptionContract: ${message}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// "" is the server's explicit representation of silence.
function requireString(value, name) {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value;
}

// The type check rejects booleans before numeric validation.
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
  const transcriptionMs = requireNonNegativeNumber(response.transcription_ms, "transcription_ms");
  const audioDurationS = requireNonNegativeNumber(response.audio_duration_s, "audio_duration_s");

  return { transcript, modelName, transcriptionMs, audioDurationS };
}
