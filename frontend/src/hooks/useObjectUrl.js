import { useEffect, useState } from "react";

// Generic single-owner object-URL lifecycle for one `File`/`Blob` at a
// time, extracted so callers that need an object URL (e.g. the
// analysed-room panel's image, kept deliberately separate from
// DeclutterUploadForm's own picker-preview URL, see that component's
// docstring and DeclutterPage's for why the two are NOT shared) get the
// same correct create/revoke behaviour without duplicating it.
//
// Deliberately relies on React's effect-cleanup ordering rather than a
// manual "revoke the previous ref, then create" sequence: whenever
// `file` changes to a new reference, React runs the *previous* effect's
// cleanup (revoking the URL that effect created) before running the new
// effect body (creating the next URL), so there is never a moment where
// two URLs for two different files are both live, and never a moment
// where the current URL is revoked while still the current one. The same
// cleanup runs once more on unmount, for whatever URL was current then.
// A `file` of `null`/`undefined` yields `url === null` with no object URL
// created, nothing to revoke in that branch.
export function useObjectUrl(file) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return undefined;
    }

    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [file]);

  return url;
}
