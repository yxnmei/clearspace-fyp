import { useCallback, useEffect, useState } from "react";
import { getImageGenHealth } from "../api/client";

// Single owner for proactive health checks and manual refresh. Availability
// comes from the response body, not merely a successful HTTP response.
export function useImageGenHealth() {
  const [status, setStatus] = useState("checking");

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
