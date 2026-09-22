import { useCallback, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
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

  // The Analyse view's own heading exists only while the request is
  // running or has failed; a successful analysis is headed by the
  // summary's "What we found" instead (the tracker already announces
  // completion), so the page never shows the same state twice.
  const analyseHeading = flow.phase === "analysing" ? "Analysing your space" : "Analysis unsuccessful";
  const showAnalyseHeading = flow.phase === "analysing" || Boolean(flow.uploadError);

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
            Choose which detected items to include, then get a prioritised tidy plan with storage and organisation
            ideas when relevant and an optional AI visual preview.
          </p>
          <ReorganiseUploadForm phase={flow.phase} error={flow.uploadError} onSubmit={handleSubmit} />
        </div>

        <div hidden={viewed !== "analyse"}>
          <section className="space-y-4">
            {showAnalyseHeading && (
              <h2 className="text-title font-semibold tracking-tight text-foreground">{analyseHeading}</h2>
            )}
            {/* One hierarchy per state: the heading above says which
                state this is, so each panel is a single calm line. */}
            {flow.phase === "analysing" && (
              <p role="status" className="flex items-center gap-2 rounded-card border border-border bg-surface-muted p-4 text-sm text-foreground">
                <Loader2 aria-hidden="true" width={16} height={16} className="shrink-0 animate-spin text-primary" />
                Finding items and preparing your next step. This may take up to two minutes.
              </p>
            )}
            {flow.uploadError && (
              <p role="alert" className="flex items-start gap-2 rounded-card border border-error/30 bg-error/10 p-4 text-sm text-error">
                <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
                <span>
                  {flow.uploadError} Your selected photo and context are still on Upload photo. Go back to Upload photo
                  and try again.
                </span>
              </p>
            )}
            {/* Success renders no heading or banner of its own: the tracker's
                live status line already says "Analysis complete." and names
                the next action, and the summary below supplies the screen's
                single visible h2. */}
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
                backLabel="Back to Analyse space"
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
              {flow.generateResult ? (
                /* The generated result carries its own "Visual preview
                   unavailable" state, so no separate health banner sits
                   beside it. */
                <ReorganiseResult
                  generateResult={flow.generateResult}
                  originalImageUrl={imageUrl}
                  onStartOver={handleStartOver}
                />
              ) : (
                <section
                  aria-labelledby="reorganise-tidy-plan-heading"
                  className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
                >
                  <h2 id="reorganise-tidy-plan-heading" className="text-title font-semibold tracking-tight text-foreground">
                    Create your tidy plan
                  </h2>
                  <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
                    Create a prioritised checklist, relevant storage and organisation ideas and an optional visual
                    preview from the {flow.selectedItemIds.length} item
                    {flow.selectedItemIds.length === 1 ? "" : "s"} you included on Select items.
                  </p>
                  {/* The image-service notice belongs here, inside the tidy
                      plan section, and is the ONE notice: the banner renders
                      nothing when the service is available, and it never
                      disables Create tidy plan. */}
                  <div className="mt-3 empty:hidden">
                    <ImageGenStatusBanner status={health.status} recheck={health.recheck} />
                  </div>
                  <Button
                    type="button"
                    className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
                    onClick={flow.generate}
                    disabled={flow.phase === "generating" || flow.selectedItemIds.length === 0}
                    aria-busy={flow.phase === "generating" || undefined}
                  >
                    {flow.phase === "generating" && <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />}
                    {flow.phase === "generating" ? "Creating tidy plan…" : flow.generateError ? "Try again" : "Create tidy plan"}
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
