import { useCallback, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useReorganiseFlow } from "../hooks/useReorganiseFlow";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { useImageGenHealth } from "../hooks/useImageGenHealth";
import { deriveReorganiseProgress } from "../lib/workflowProgress";
import WorkflowProgress from "./WorkflowProgress";
import WizardNav from "./WizardNav";
import ImageGenStatusBanner from "./ImageGenStatusBanner";
import ReorganiseUploadForm from "./ReorganiseUploadForm";
import ReorganiseAnalysisSummary from "./ReorganiseAnalysisSummary";
import ReorganiseItemSelector from "./ReorganiseItemSelector";
import ReorganiseResult from "./ReorganiseResult";
import { Button } from "./ui/button";

// Direct Reorganise uses the same presentation model as Declutter: every
// tracker step is a separate mounted-but-hidden screen, navigation is local
// presentation state, and the hook remains the sole owner of API state.
export default function ReorganisePage() {
  const flow = useReorganiseFlow();
  const health = useImageGenHealth();
  const imageUrl = useObjectUrl(flow.file);
  const [viewedStep, setViewedStep] = useState("upload");
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);

  const hasAnalysis = Boolean(flow.analysis);
  const wizard = deriveReorganiseProgress({
    phase: flow.phase,
    uploadError: flow.uploadError,
    generateError: flow.generateError,
    hasAnalysis,
    selectedItemCount: flow.selectedItemIds.length,
    viewedStep,
    reviewAcknowledged,
  });
  const viewed = wizard.viewedStepId;

  const handleSubmit = useCallback(
    (payload) => {
      setReviewAcknowledged(false);
      setViewedStep("analyse");
      return flow.submit(payload);
    },
    [flow.submit]
  );

  const goToStep = useCallback(
    (stepId) => {
      if (wizard.navigationLocked || !wizard.unlockedStepIds.includes(stepId)) return;
      setViewedStep(stepId);
    },
    [wizard.navigationLocked, wizard.unlockedStepIds]
  );

  const handleContinue = useCallback(() => {
    if (!wizard.canContinue || !wizard.continueTargetId) return;
    if (wizard.continueTargetId === "generate") setReviewAcknowledged(true);
    setViewedStep(wizard.continueTargetId);
  }, [wizard.canContinue, wizard.continueTargetId]);

  const handleStartOver = useCallback(() => {
    flow.reset();
    setReviewAcknowledged(false);
    setViewedStep("upload");
  }, [flow.reset]);

  const analyseHeading = flow.phase === "analysing"
    ? "Analysing your room"
    : flow.uploadError
      ? "Analysis unsuccessful"
      : "Analysis complete";

  return (
    <div>
      <WorkflowProgress
        workflowName={wizard.workflowName}
        steps={wizard.steps}
        currentStepId={wizard.currentStepId}
        viewedStepId={viewed}
        completedStepIds={wizard.completedStepIds}
        unlockedStepIds={wizard.unlockedStepIds}
        onStepSelect={goToStep}
        navigationLocked={wizard.navigationLocked}
        processing={wizard.processing}
        statusText={wizard.statusText}
        nextActionText={wizard.nextActionText}
      />

      <div className="mt-6">
        <div hidden={viewed !== "upload"}>
          <p className="mb-6 max-w-2xl text-muted-foreground">
            Analyse a room, review which detected items belong in the plan, then generate a prioritised
            reorganisation checklist, storage suggestions when relevant and an optional AI visual preview.
          </p>
          <ReorganiseUploadForm phase={flow.phase} error={flow.uploadError} onSubmit={handleSubmit} />
        </div>

        <div hidden={viewed !== "analyse"}>
          <section className="space-y-4">
            <h2 className="text-title font-semibold tracking-tight text-foreground">{analyseHeading}</h2>
            {flow.phase === "analysing" && (
              <p role="status" className="flex items-center gap-2 rounded-card border border-border bg-surface-muted p-4 text-sm text-foreground">
                <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin text-primary" />
                Scene classification and object detection are running. This can take up to two minutes on this
                computer. The tracker stays locked until analysis finishes.
              </p>
            )}
            {flow.uploadError && (
              <p role="alert" className="flex items-start gap-2 rounded-card border border-error/30 bg-error/10 p-4 text-sm text-error">
                <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
                <span>{flow.uploadError} Go back to Upload photo and try again.</span>
              </p>
            )}
            {hasAnalysis && flow.phase !== "analysing" && (
              <p role="status" className="flex items-start gap-2 rounded-card border border-success/30 bg-success/10 p-4 text-sm text-foreground">
                <Check aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-success" />
                <span>ClearSpace finished analysing your room. Continue to Select items to check the detected items.</span>
              </p>
            )}
            {hasAnalysis && <ReorganiseAnalysisSummary analysis={flow.analysis} />}
            <WizardNav
              backLabel="Back to Upload photo"
              onBack={() => goToStep("upload")}
              backDisabled={wizard.navigationLocked}
              continueLabel="Continue to Select items"
              onContinue={handleContinue}
              continueDisabled={!(viewed === "analyse" && wizard.canContinue)}
            />
          </section>
        </div>

        <div hidden={viewed !== "review"}>
          {hasAnalysis && (
            <>
              <ReorganiseItemSelector
                items={flow.items}
                selectedItemIds={flow.selectedItemIds}
                onToggleItem={flow.toggleItemSelected}
                imageUrl={imageUrl}
                selectionDisabled={flow.phase !== "selecting"}
                enableBackToTop
              />
              <WizardNav
                backLabel="Back to Analyse room"
                onBack={() => goToStep("analyse")}
                backDisabled={wizard.navigationLocked}
                continueLabel="Continue to Tidy plan"
                onContinue={handleContinue}
                continueDisabled={!(viewed === "review" && wizard.canContinue)}
              />
            </>
          )}
        </div>

        <div hidden={viewed !== "generate"}>
          {hasAnalysis && (
            <div className="space-y-6">
              <ImageGenStatusBanner status={health.status} recheck={health.recheck} />

              {flow.generateResult ? (
                <ReorganiseResult
                  generateResult={flow.generateResult}
                  items={flow.items}
                  originalImageUrl={imageUrl}
                  onStartOver={handleStartOver}
                />
              ) : (
                <section className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground">4. Generate reorganisation plan</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Generate a prioritised checklist, storage suggestions when relevant and a visual preview using the{" "}
                    {flow.selectedItemIds.length} item
                    {flow.selectedItemIds.length === 1 ? "" : "s"} you included during Review.
                  </p>
                  {health.status === "unavailable" && (
                    <p className="mt-3 rounded-control border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
                      The image service is offline, so the plan can still complete without a visual preview.
                    </p>
                  )}
                  <Button
                    type="button"
                    className="mt-4"
                    onClick={flow.generate}
                    disabled={flow.phase === "generating" || flow.selectedItemIds.length === 0}
                    aria-busy={flow.phase === "generating" || undefined}
                  >
                    {flow.phase === "generating" && <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />}
                    {flow.phase === "generating" ? "Generating…" : flow.generateError ? "Try again" : "Generate reorganisation plan"}
                  </Button>
                  {flow.phase === "generating" && (
                    <p role="status" className="mt-3 text-sm text-muted-foreground">
                      Creating your checklist and visual preview. This may take several minutes.
                    </p>
                  )}
                  {flow.generateError && (
                    <p role="alert" className="mt-3 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error">
                      {flow.generateError} Your reviewed selection is unchanged. You can try again.
                    </p>
                  )}
                </section>
              )}

              <WizardNav
                backLabel="Back to Select items"
                onBack={() => goToStep("review")}
                backDisabled={wizard.navigationLocked}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
