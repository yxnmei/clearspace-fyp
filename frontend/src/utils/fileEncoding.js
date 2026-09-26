// Use the browser's base64 encoder and strip the data-URL prefix.

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      const commaIndex = typeof result === "string" ? result.indexOf(",") : -1;
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };

    // Always reject with an Error and let client callers propagate it.
    reader.onerror = () => {
      reject(reader.error instanceof Error ? reader.error : new Error("Failed to read file"));
    };

    reader.readAsDataURL(file);
  });
}
