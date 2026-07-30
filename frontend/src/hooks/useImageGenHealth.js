import { useCallback, useEffect, useState } from "react";
import { getImageGenHealth } from "../api/client";

// §5: the UI checks Colab/ngrok health up front, before the user ever
// clicks Reorganise — not only on failure after they try. Poll on mount
// and expose a manual refresh for a "check again" button.
export function useImageGenHealth() {
  const [status, setStatus] = useState("checking"); // "checking" | "available" | "unavailable"

  const check = useCallback(async () => {
    setStatus("checking");
    try {
      await getImageGenHealth();
      setStatus("available");
    } catch {
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  return { status, recheck: check };
}
