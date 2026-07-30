import { useCallback, useState } from "react";
import { overrideItem, uploadImage } from "../api/client";

// Per-flow state + logic pulled into a hook from the start (§4), rather
// than living inline inside a growing DeclutterPage component. Backend
// /upload isn't implemented yet (see app/services/declutter_service.py),
// so this hook is wired but will surface that NotImplementedError as a
// normal caught error until §3 build order step 5/6 lands.

export function useDeclutterFlow() {
  const [status, setStatus] = useState("idle"); // idle | uploading | ready | error
  const [runId, setRunId] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);

  const submit = useCallback(async ({ file, context }) => {
    setStatus("uploading");
    setError(null);
    try {
      const result = await uploadImage({ file, path: "declutter", context });
      setRunId(result.run_id);
      setItems(result.items ?? []);
      setStatus("ready");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }, []);

  const override = useCallback(
    async (itemId, newLabel) => {
      if (!runId) return;
      const updated = await overrideItem({ itemId, newLabel, runId });
      setItems((prev) => prev.map((item) => (item.id === itemId ? updated : item)));
    },
    [runId]
  );

  return { status, runId, items, error, submit, override };
}
