import { useCallback, useState } from "react";
import { overrideItem, uploadImage } from "../api/client";
import { normaliseDeclutterUploadResponse } from "../api/declutterContract";

// Per-flow state + logic pulled into a hook from the start (§4), rather
// than living inline inside a growing DeclutterPage component. Backend
// POST /upload (declutter path) is implemented — see
// app/api/routes.py and app/services/declutter_service.py — its nested
// { run_id, path, analysis, declutter } response is passed through
// normaliseDeclutterUploadResponse() (api/declutterContract.js), which
// joins detections to decisions by item_id and throws on a malformed
// contract rather than silently returning an empty item list.

const EMPTY_FLOW = { runId: null, analysis: null, declutter: null, items: [] };

export function useDeclutterFlow() {
  const [status, setStatus] = useState("idle"); // idle | uploading | ready | error
  const [flow, setFlow] = useState(EMPTY_FLOW);
  const [error, setError] = useState(null);

  const submit = useCallback(async ({ file, context }) => {
    setStatus("uploading");
    setError(null);
    setFlow(EMPTY_FLOW); // clear the previous result before a new upload starts

    try {
      const response = await uploadImage({ file, path: "declutter", context });
      setFlow(normaliseDeclutterUploadResponse(response));
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Declutter upload failed");
      setStatus("error");
    }
  }, []);

  const override = useCallback(
    async (itemId, newLabel) => {
      if (!flow.runId) return;
      const updated = await overrideItem({ itemId, newLabel, runId: flow.runId });
      setFlow((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          // item_id, never id — id was never a real field on either the
          // detection or the joined review item.
          item.item_id === itemId ? { ...item, ...updated, item_id: item.item_id } : item
        ),
      }));
    },
    [flow.runId]
  );

  return {
    status,
    runId: flow.runId,
    analysis: flow.analysis,
    declutter: flow.declutter,
    items: flow.items,
    error,
    submit,
    override,
  };
}
