import { useReorganiseFlow } from "../hooks/useReorganiseFlow";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { useImageGenHealth } from "../hooks/useImageGenHealth";
import { deriveReorganiseProgress } from "../lib/workflowProgress";
import WorkflowProgress from "./WorkflowProgress";
import ImageGenStatusBanner from "./ImageGenStatusBanner";
import ReorganiseUploadForm from "./ReorganiseUploadForm";
import ReorganiseItemSelector from "./ReorganiseItemSelector";
import ReorganiseResult from "./ReorganiseResult";

// Top-level Direct Reorganise workflow, mirrors DeclutterPage's role
// (wires hook state to screen sections, never calls the API directly).
//
// THE ONE owner of useImageGenHealth() for the whole Reorganise flow
// (required correction 1): ImageGenStatusBanner is purely presentational
// and receives {status, recheck} as props here rather than calling the
// hook itself, and ReorganiseItemSelector's own advisory copy reads the
// SAME status value, so mounting this page issues exactly one
// GET /image-gen/health request, never two.
//
// useObjectUrl(flow.file) reuses the existing, unchanged, already-tested
// hook, flow.file is retained by useReorganiseFlow for the whole
// upload -> select -> generate lifecycle (unlike Declutter, which never
// needs the image again after upload), so the SAME object URL persists
// correctly through analysing/selecting/generating/result and is
// revoked/replaced exactly when useReorganiseFlow's own file state
// changes (a new upload, or reset() setting it back to null).
// The "Back to workflows" control lives in AppShell (rendered by App for
// every workflow page), so this page no longer renders its own.
export default function ReorganisePage() {
  const flow = useReorganiseFlow();
  const health = useImageGenHealth();
  const imageUrl = useObjectUrl(flow.file);

  const progress = deriveReorganiseProgress({
    phase: flow.phase,
    uploadError: flow.uploadError,
    generateError: flow.generateError,
  });

  return (
    <div>
      <WorkflowProgress {...progress} />

      <div className="mt-6">
        <ImageGenStatusBanner status={health.status} recheck={health.recheck} />
      </div>

      <div className="mt-4">
        {flow.phase === "upload" || flow.phase === "analysing" ? (
          <ReorganiseUploadForm phase={flow.phase} error={flow.uploadError} onSubmit={flow.submit} />
        ) : null}

        {flow.phase === "selecting" || flow.phase === "generating" ? (
          <ReorganiseItemSelector
            items={flow.items}
            selectedItemIds={flow.selectedItemIds}
            onToggleItem={flow.toggleItemSelected}
            imageUrl={imageUrl}
            phase={flow.phase}
            onGenerate={flow.generate}
            generateError={flow.generateError}
            healthStatus={health.status}
          />
        ) : null}

        {flow.phase === "result" && flow.generateResult ? (
          <ReorganiseResult
            generateResult={flow.generateResult}
            items={flow.items}
            originalImageUrl={imageUrl}
            onStartOver={flow.reset}
          />
        ) : null}
      </div>
    </div>
  );
}
