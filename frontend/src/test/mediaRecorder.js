// Per-test MediaRecorder / getUserMedia fakes.
//
// Deliberately NOT installed globally in src/test/setup.js. jsdom
// implements neither `MediaRecorder` nor `navigator.mediaDevices`, and
// that absence is exactly what useVoiceContext's feature detection has
// to react to — a global stub would make the unsupported-browser
// fallback permanently untestable. So every install() here returns its
// own restore(), and each test installs only what it needs and tears it
// down again afterwards, leaving the next test back in a browser that
// cannot record.
//
// The fakes are hand-driven: nothing fires on a timer. A test calls
// `recorder.emitData(...)` / `recorder.finish()` itself, so recording
// tests contain no waiting and no real audio.

/** One microphone track. `stopCount` is what the "tracks are stopped on
 *  every exit path" tests assert on. */
export class FakeMediaStreamTrack {
  constructor(kind = "audio") {
    this.kind = kind;
    this.readyState = "live";
    this.stopCount = 0;
  }

  stop() {
    this.stopCount += 1;
    this.readyState = "ended";
  }
}

export class FakeMediaStream {
  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new FakeMediaStreamTrack());
  }

  getTracks() {
    return [...this.tracks];
  }
}

/**
 * Minimal MediaRecorder stand-in covering only what the hook uses:
 * construction with an optional mimeType, start(), stop(), state, and
 * the ondataavailable/onstop/onerror handler properties.
 *
 * `stop()` does NOT synchronously fire onstop — the real API dispatches
 * `dataavailable` then `stop` asynchronously, and pretending otherwise
 * would hide ordering bugs. Tests call finish() to complete the cycle.
 */
export function createRecorderClass({ supportedTypes = [], constructorError = null } = {}) {
  const instances = [];

  class FakeMediaRecorder {
    static isTypeSupported(type) {
      return supportedTypes.includes(type);
    }

    constructor(stream, options = {}) {
      if (constructorError) throw constructorError;
      this.stream = stream;
      this.requestedMimeType = options.mimeType ?? null;
      // The real API reports the type it actually settled on.
      this.mimeType = options.mimeType ?? "audio/webm";
      this.state = "inactive";
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
      this.startCount = 0;
      this.stopCount = 0;
      instances.push(this);
    }

    start() {
      this.startCount += 1;
      this.state = "recording";
    }

    stop() {
      this.stopCount += 1;
      this.state = "inactive";
    }

    /** Hand-delivered chunk, as the browser would during recording. */
    emitData(parts = ["chunk"], type = this.mimeType) {
      this.ondataavailable?.({ data: new Blob(parts, { type }) });
    }

    /** Deliver chunks (if any) and then the stop event, in browser order. */
    finish({ chunks = [["chunk"]], type = this.mimeType } = {}) {
      for (const parts of chunks) this.emitData(parts, type);
      this.onstop?.({});
    }

    /**
     * A recorder-level failure, e.g. the device disappearing mid-take.
     *
     * Models the sequence the MediaRecorder specification actually
     * permits: `error`, THEN a final `dataavailable` carrying whatever
     * was buffered, THEN `stop`. Firing only `error` would hide the
     * exact ordering bug this models — a failed take whose trailing
     * stop event still starts a transcription.
     */
    fail({ chunks = [["partial"]], type = this.mimeType, error = new Error("recorder failed") } = {}) {
      this.state = "inactive";
      this.onerror?.({ error });
      for (const parts of chunks) this.emitData(parts, type);
      this.onstop?.({});
    }
  }

  return { FakeMediaRecorder, instances };
}

function defineOwn(target, key, value) {
  const had = Object.prototype.hasOwnProperty.call(target, key);
  const previous = had ? Object.getOwnPropertyDescriptor(target, key) : null;

  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });

  return () => {
    if (had && previous) Object.defineProperty(target, key, previous);
    else delete target[key];
  };
}

/**
 * Install a fake MediaRecorder for one test.
 *
 * @returns {{ FakeMediaRecorder: Function, instances: Array, last: () => object, restore: () => void }}
 */
export function installMediaRecorder(options = {}) {
  const { FakeMediaRecorder, instances } = createRecorderClass(options);
  const undo = defineOwn(window, "MediaRecorder", FakeMediaRecorder);

  return {
    FakeMediaRecorder,
    instances,
    last: () => instances[instances.length - 1],
    restore: undo,
  };
}

/**
 * Install a fake navigator.mediaDevices.getUserMedia for one test.
 *
 * Pass `error` to simulate a denied permission (a DOMException-shaped
 * object with the real `name`, which the hook branches on). Otherwise a
 * FakeMediaStream is handed out and recorded in `streams`.
 */
export function installGetUserMedia({
  error = null,
  trackCount = 1,
  stream = null,
  deferred = false,
} = {}) {
  const streams = [];
  const calls = [];
  const pending = [];

  const getUserMedia = (constraints) => {
    calls.push(constraints);
    if (error) return Promise.reject(error);
    const next = stream ?? new FakeMediaStream(trackCount);
    streams.push(next);
    // `deferred` models a permission prompt the user has not answered
    // yet — the test decides when (and whether) it is ever granted.
    if (deferred) {
      return new Promise((resolve) => {
        pending.push(() => resolve(next));
      });
    }
    return Promise.resolve(next);
  };

  const undo = defineOwn(navigator, "mediaDevices", { getUserMedia });

  return {
    streams,
    calls,
    last: () => streams[streams.length - 1],
    /** Grant a deferred permission prompt. */
    grant: () => pending.shift()?.(),
    restore: undo,
  };
}

/** Both halves at once, for the ordinary "recording works" case. */
export function installRecordingSupport({
  supportedTypes = ["audio/webm;codecs=opus", "audio/webm"],
  trackCount = 1,
  constructorError = null,
  error = null,
  deferred = false,
} = {}) {
  const recorder = installMediaRecorder({ supportedTypes, constructorError });
  const media = installGetUserMedia({ trackCount, error, deferred });

  return {
    recorder,
    media,
    restore: () => {
      media.restore();
      recorder.restore();
    },
  };
}

/** A DOMException-shaped denial, matching what a real browser rejects with. */
export function permissionDeniedError(name = "NotAllowedError") {
  const error = new Error("Permission denied");
  error.name = name;
  return error;
}
