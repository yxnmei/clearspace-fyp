import { useCallback, useEffect, useState } from "react";
import { getImageGenHealth } from "../api/client";

// §5: the UI checks Colab/ngrok health up front, before the user ever
// clicks Reorganise, not only on failure after they try. Poll on mount
// and expose a manual refresh for a "check again" button.
//
// This is the ONE owner of the health check for the whole app, see
// ReorganisePage, which calls this hook exactly once and passes the
// resulting {status, recheck} down to both ImageGenStatusBanner and the
// item-selection screen's advisory copy, rather than either of them
// calling this hook themselves. Mounting two independent instances would
// issue two GET /image-gen/health requests for no reason.
//
// Reads the actual response body (GET /image-gen/health always returns
// HTTP 200, see app/api/routes.py's ImageGenHealthResponse) rather than
// treating "the fetch didn't throw" as "available": a 200 response with
// {"available": false} must still become "unavailable" here.
export function useImageGenHealth() {
  const [status, setStatus] = useState("checking"); // "checking" | "available" | "unavailable"

  const check = useCallback(async () => {
    setStatus("checking");
    try {
      const response = await getImageGenHealth();
      setStatus(response && response.available === true ? "available" : "unavailable");
    } catch {
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  return { status, recheck: check };
}
