import { useCallback, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useBothFlow } from "../hooks/useBothFlow";
import { useImageGenHealth } from "../hooks/useImageGenHealth";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { deriveBothProgress } from "../lib/workflowProgress";
import {
  partitionReviewItems,
  deriveReviewCounts,
  totalStageDurationMs,
  isConfirmBlocked,
} from "../lib/declutterReview";
import WorkflowProgress from "./WorkflowProgress";
import WizardNav from "./WizardNav";
import ImageGenStatusBanner from "./ImageGenStatusBanner";
import DeclutterUploadForm from "./DeclutterUploadForm";
import DeclutterAnalysisSummary from "./DeclutterAnalysisSummary";
import DeclutterReviewSection from "./DeclutterReviewSection";
import DecisionActionBar, { describeContinueBlocker } from "./DecisionActionBar";
import DeclutterConfirmationPanel from "./DeclutterConfirmationPanel";
import ConfirmationSummary from "./ConfirmationSummary";
import ReorganiseResult from "./ReorganiseResult";
import ListingsView from "./ListingsView";
import { Button } from "./ui/button";

const NEXT_STEP_NOTE =
  "Your confirmed choices are ready. On the next screen, listings and reorganisation are separate actions and neither starts automatically.";

// Both uses the same mounted-but-hidden wizard pattern as Declutter. The
// hook remains the sole owner of workflow, listing and generation state;
// this component only controls which unlocked screen the user is viewing.
export default function BothPage() {
  const flow = useBothFlow();
  const health = useImageGenHealth();
  const imageUrl = useObjectUrl(flow.file);
  const [viewedStep, setViewedStep] = useState("upload");
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);

  const hasAnalysis = Boolean(flow.analysis && flow.declutter);
  const hasConfirmation = flow.confirmationStatus === "confirmed" && flow.confirmation !== null;
  const { resolvedItems, unresolvedItems, contextualItems } = partitionReviewItems(flow.reviewItems);
  const { counts, changedCount, excludedCount } = deriveReviewCounts(resolvedItems);
  const unresolvedCount = unresolvedItems.length;
  const decideItemCount = resolvedItems.length + unresolvedCount;
  const totalDurationMs = totalStageDurationMs(flow.analysis);
  const confirmDisabled = isConfirmBlocked({
    confirmationStatus: flow.confirmationStatus,
    declutter: flow.declutter,
    unresolvedCount,
    correctingItemId: flow.correctingItemId,
  });

  const wizard = deriveBothProgress({
    status: flow.status,
    analysis: flow.analysis,
    declutter: flow.declutter,
    confirmationStatus: flow.confirmationStatus,
    confirmation: flow.confirmation,
    generationStatus: flow.generationStatus,
    generateResult: flow.generateResult,
    listingStatus: flow.listingStatus,
    regeneratingItemId: flow.regeneratingItemId,
    unresolvedCount,
    correctingItemId: flow.correctingItemId,
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
    if (wizard.continueTargetId === "confirm") setReviewAcknowledged(true);
    setViewedStep(wizard.continueTargetId);
  }, [wizard.canContinue, wizard.continueTargetId]);

  const handleStartOver = useCallback(() => {
    flow.reset();
    setReviewAcknowledged(false);
    setViewedStep("upload");
  }, [flow.reset]);

  const analyseHeading =
    flow.status === "error"
      ? "Analysis unsuccessful"
      : flow.status === "ready" && hasAnalysis
        ? "Analysis complete"
        : "Analysing your room";

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
            Review Keep / Sell / Donate / Discard suggestions, then independently create marketplace listings
            and a reorganisation checklist from your confirmed choices.
          </p>
          <DeclutterUploadForm status={flow.status} error={flow.error} onSubmit={handleSubmit} />
        </div>

        <div hidden={viewed !== "analyse"}>
          <section className="space-y-4">
            <h2 className="text-title font-semibold tracking-tight text-foreground">{analyseHeading}</h2>

            {flow.status === "uploading" && (
              <p
                role="status"
                className="flex items-center gap-2 rounded-card border border-border bg-surface-muted p-4 text-sm text-foreground"
              >
                <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin text-primary" />
                Scene classification, object detection and item reasoning are running. This can take up to two
                minutes on this computer. The tracker stays locked until analysis finishes.
              </p>
            )}

            {flow.status === "error" && flow.error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-card border border-error/30 bg-error/10 p-4 text-sm text-error"
              >
                <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
                <span>{flow.error} Go back to Upload photo and try again.</span>
              </p>
            )}

            {flow.status === "ready" && hasAnalysis && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-card border border-success/30 bg-success/10 p-4 text-sm text-foreground"
              >
                <Check aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0 text-success" />
                <span>
                  ClearSpace finished analysing your room. Continue to Decide items to check each detected item and
                  the action it suggests.
                </span>
              </p>
            )}

            {hasAnalysis && (
              <DeclutterAnalysisSummary
                analysis={flow.analysis}
                declutter={flow.declutter}
                contextualCount={contextualItems.length}
                totalDurationMs={totalDurationMs}
              />
            )}

            <WizardNav
              backLabel="Back to Upload photo"
              onBack={() => goToStep("upload")}
              backDisabled={wizard.navigationLocked}
              continueLabel="Continue to Decide items"
              onContinue={handleContinue}
              continueDisabled={!(viewed === "analyse" && wizard.canContinue)}
            />
          </section>
        </div>

        <div hidden={viewed !== "review"}>
          {hasAnalysis && (
            <>
              <DeclutterReviewSection
                reviewItems={flow.reviewItems}
                imageUrl={imageUrl}
                setDecisionOverride={flow.setDecisionOverride}
                setItemExcluded={flow.setItemExcluded}
                correctLabel={flow.correctLabel}
                correctingItemId={flow.correctingItemId}
                correctionError={flow.correctionError}
                enableBackToTop
              />
              {/* Same shared bar as the Declutter wizard: the only Back /
                  Continue pair on this screen, guard unchanged. */}
              <DecisionActionBar
                totalCount={decideItemCount}
                counts={counts}
                backLabel="Back to Analyse room"
                onBack={() => goToStep("analyse")}
                backDisabled={wizard.navigationLocked}
                continueLabel="Continue to Confirm choices"
                onContinue={handleContinue}
                continueDisabled={!wizard.canContinueFromReview || wizard.navigationLocked}
                blockedReason={describeContinueBlocker({
                  hasAnalysis,
                  navigationLocked: wizard.navigationLocked,
                  correctingItemId: flow.correctingItemId,
                  unresolvedCount,
                })}
              />
            </>
          )}
        </div>

        <div hidden={viewed !== "confirm"}>
          {hasAnalysis && (
            <div className="space-y-6">
              <DeclutterConfirmationPanel
                counts={counts}
                changedCount={changedCount}
                excludedCount={excludedCount}
                unresolvedCount={unresolvedCount}
                confirmDisabled={confirmDisabled}
                confirmationStatus={flow.confirmationStatus}
                confirmationError={flow.confirmationError}
                onConfirm={flow.confirm}
              />

              {flow.confirmation && (
                <ConfirmationSummary
                  confirmation={flow.confirmation}
                  reviewItems={flow.reviewItems}
                  nextStepNote={NEXT_STEP_NOTE}
                />
              )}

              <WizardNav
                backLabel="Back to Decide items"
                onBack={() => goToStep("review")}
                backDisabled={wizard.navigationLocked}
                continueLabel="Continue to Results"
                onContinue={hasConfirmation ? handleContinue : undefined}
                continueDisabled={!(viewed === "confirm" && wizard.canContinue)}
              />
            </div>
          )}
        </div>

        <div hidden={viewed !== "reorganise"}>
          {hasAnalysis && hasConfirmation && (
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
                  <h2 className="text-lg font-semibold text-foreground">Reorganise your confirmed Keep items</h2>
                  {flow.confirmation.confirmedKeepIds.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      No items were confirmed as Keep, so there is nothing to reorganise. Listing drafts are
                      still available below for confirmed Sell items.
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Generate a prioritised checklist, focus areas, storage suggestions and a visual preview using
                        the {flow.confirmation.confirmedKeepIds.length} confirmed Keep item
                        {flow.confirmation.confirmedKeepIds.length === 1 ? "" : "s"}.
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
                        disabled={flow.generationStatus === "generating"}
                        aria-busy={flow.generationStatus === "generating" || undefined}
                      >
                        {flow.generationStatus === "generating" && (
                          <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />
                        )}
                        {flow.generationStatus === "generating"
                          ? "Generating…"
                          : flow.generateError
                            ? "Try again"
                            : "Generate reorganisation plan"}
                      </Button>
                      {flow.generationStatus === "generating" && (
                        <p role="status" className="mt-3 text-sm text-muted-foreground">
                          Creating your checklist and visual preview. This may take several minutes.
                        </p>
                      )}
                      {flow.generateError && (
                        <p
                          role="alert"
                          className="mt-3 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
                        >
                          {flow.generateError} Your confirmed decisions are unchanged. You can try again.
                        </p>
                      )}
                    </>
                  )}
                </section>
              )}

              <ListingsView
                confirmation={flow.confirmation}
                reviewItems={flow.reviewItems}
                imageUrl={imageUrl}
                listingStatus={flow.listingStatus}
                listingDrafts={flow.listingDrafts}
                listingError={flow.listingError}
                regeneratingItemId={flow.regeneratingItemId}
                regenerationError={flow.regenerationError}
                generateListingDrafts={flow.generateListingDrafts}
                regenerateListingDraft={flow.regenerateListingDraft}
                editListingDraft={flow.editListingDraft}
                discardListingDraft={flow.discardListingDraft}
                restoreListingDraft={flow.restoreListingDraft}
              />

              <WizardNav
                backLabel="Back to Confirm choices"
                onBack={() => goToStep("confirm")}
                backDisabled={wizard.navigationLocked}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
