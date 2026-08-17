// Pure-ish (one browser API call) file-encoding helper — extracted from
// client.js/the hook so it has its own small, isolated, unit-tested
// surface (matching this project's existing convention of keeping
// format.js/api/*Contract.js focused and independently testable), rather
// than living inline inside generateReorganisation() or useReorganiseFlow.
//
// Uses FileReader.readAsDataURL() (supported by jsdom, this project's
// configured test environment — see vite.config.js) rather than manually
// reading an ArrayBuffer and base64-encoding it by hand: the browser
// already produces correct base64, so there is no custom encoding logic
// here to get wrong. The data: URL prefix ("data:<mime>;base64,") is
// stripped — POST /generate's `image` field must be strict base64 with
// no prefix (see app/api/routes.py's GenerateRequest).

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      const commaIndex = typeof result === "string" ? result.indexOf(",") : -1;
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };

    // FileReader failures (unreadable file, permission issues, etc.) reject
    // with a real Error — propagates uncaught through generateReorganisation(),
    // matching every client.js function's existing "errors propagate, never
    // swallowed" convention.
    reader.onerror = () => {
      reject(reader.error instanceof Error ? reader.error : new Error("Failed to read file"));
    };

    reader.readAsDataURL(file);
  });
}
