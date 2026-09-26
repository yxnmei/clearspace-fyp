import { useCallback, useState } from "react";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import DeclutterResultsSummary from "./DeclutterResultsSummary";
import { useDeclutterFlow } from "../hooks/useDeclutterFlow";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { deriveDeclutterWizard } from "../lib/declutterWizard";
import { deriveEligibleSellItemIds } from "../lib/listingDrafts";
import {
  partitionReviewItems,
  deriveReviewCounts,
  isConfirmBlocked,
} from "../lib/declutterReview";
import WorkflowProgress from "./WorkflowProgress";
import WizardNav from "./WizardNav";
import DeclutterUploadForm from "./DeclutterUploadForm";
import DeclutterAnalysisSummary from "./DeclutterAnalysisSummary";
import DeclutterReviewSection from "./DeclutterReviewSection";
import DecisionActionBar, { describeContinueBlocker } from "./DecisionActionBar";
import DeclutterConfirmationPanel from "./DeclutterConfirmationPanel";
import ListingsView from "./ListingsView";

// Hidden mounted views preserve presentation state. The hook owns workflow
// state; submittedFile keeps the analysed image and listing crops stable.
export default function DeclutterPage() {
  const {
    status,
    analysis,
    declutter,
    error,
    submit,
    reviewItems,
    confirmation,
    confirmationStatus,
    confirmationError,
    setDecisionOverride,
    setItemExcluded,
    confirm,
    correctLabel,
    correctingItemId,
    correctionError,
    listingStatus,
    listingDrafts,
    listingError,
    regeneratingItemId,
    regenerationError,
    generateListingDrafts,
    regenerateListingDraft,
    editListingDraft,
    discardListingDraft,
    restoreListingDraft,
    listingDetailsById,
    setListingDetails,
    missingListingItemIds,
    reset,
  } = useDeclutterFlow();

  const [submittedFile, setSubmittedFile] = useState(null);
  const analysedImageUrl = useObjectUrl(submittedFile);

  const [viewedStep, setViewedStep] = useState("upload");
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false);

  const hasAnalysis = Boolean(analysis && declutter);
  const { resolvedItems, unresolvedItems } = partitionReviewItems(reviewItems);
  const { counts, changedCount, excludedCount } = deriveReviewCounts(resolvedItems);
  const unresolvedCount = unresolvedItems.length;
  const decideItemCount = resolvedItems.length + unresolvedCount;
  const confirmDisabled = isConfirmBlocked({ confirmationStatus, declutter, unresolvedCount, correctingItemId });

  // On success the summary supplies the only heading.
  const analyseHeading = status === "error" ? "Analysis unsuccessful" : "Analysing your space";
  const showAnalyseHeading = !(status === "ready" && hasAnalysis);

  // Derive eligible Sell count from confirmation, never labels or drafts.
  const eligibleSellCount = deriveEligibleSellItemIds(confirmation).length;

  const wizard = deriveDeclutterWizard({
    status,
    uploadError: error,
    hasAnalysis,
    confirmationStatus,
    hasConfirmation: Boolean(confirmation),
    correctingItemId,
    unresolvedCount,
    viewedStep,
    confirmAcknowledged,
    listingStatus,
    eligibleSellCount,
    regeneratingItemId,
    regenerationError,
  });
  const viewed = wizard.viewedStepId;

  const handleSubmit = useCallback(
    ({ file, context }) => {
      setSubmittedFile(file); // Keep the analysed image stable.
      setConfirmAcknowledged(false); // Relock Review and Confirm.
      setViewedStep("analyse");
      return submit({ file, context });
    },
    [submit]
  );

  const goToStep = useCallback(
    (stepId) => {
      if (wizard.navigationLocked) return;
      if (!wizard.unlockedStepIds.includes(stepId)) return;
      setViewedStep(stepId);
    },
    [wizard.navigationLocked, wizard.unlockedStepIds]
  );

  const handleContinue = useCallback(() => {
    if (!wizard.canContinue || !wizard.continueTargetId) return;
    if (wizard.continueTargetId === "confirm") setConfirmAcknowledged(true);
    setViewedStep(wizard.continueTargetId);
  }, [wizard.canContinue, wizard.continueTargetId]);

  // Edit links request a review filter; the nonce permits repeat requests.
  const [filterRequest, setFilterRequest] = useState(null);
  const handleEditCategory = useCallback(
    (filterId) => {
      setFilterRequest((previous) => ({ id: filterId, nonce: (previous?.nonce ?? 0) + 1 }));
      goToStep("review");
    },
    [goToStep]
  );

  const handleStartOver = useCallback(() => {
    reset();
    setSubmittedFile(null);
    setConfirmAcknowledged(false);
    setViewedStep("upload");
  }, [reset]);

  return (
    <div>
      <WorkflowProgress
        workflowName={wizard.workflowName}
        steps={wizard.steps}
        currentStepId={viewed}
        viewedStepId={viewed}
        completedStepIds={wizard.completedStepIds}
        unlockedStepIds={wizard.unlockedStepIds}
        onStepSelect={goToStep}
        navigationLocked={wizard.navigationLocked}
        processing={wizard.processing}
        statusText={wizard.statusText}
        nextActionText={wizard.nextActionText}
      />

      <div className="mt-4">
        <div hidden={viewed !== "upload"}>
          <p className="mb-4 max-w-2xl text-muted-foreground">
            Get a suggested action for every item, then review and confirm each one.
          </p>
          <DeclutterUploadForm status={status} error={error} onSubmit={handleSubmit} />
        </div>

        <div hidden={viewed !== "analyse"}>
          <section className="space-y-4">
            {showAnalyseHeading && (
              <h2 className="text-title font-semibold tracking-tight text-foreground">{analyseHeading}</h2>
            )}

            {status === "uploading" && (
              <p
                role="status"
                className="flex items-center gap-2 rounded-card border border-border bg-surface-muted p-4 text-sm text-foreground"
              >
                <Loader2 aria-hidden="true" width={16} height={16} className="shrink-0 animate-spin text-primary" />
                Finding items and preparing your next step. This may take up to two minutes.
              </p>
            )}

            {status === "error" && error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-card border border-error/30 bg-error/10 p-4 text-sm text-error"
              >
                <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
                <span>
                  {error} Your selected photo and context are still on Upload photo. Go back to Upload photo and try
                  again.
                </span>
              </p>
            )}

            {hasAnalysis && <DeclutterAnalysisSummary analysis={analysis} declutter={declutter} />}

            <WizardNav
              backLabel="Back to Upload photo"
              onBack={() => goToStep("upload")}
              backDisabled={wizard.navigationLocked || !wizard.unlockedStepIds.includes("upload")}
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
                reviewItems={reviewItems}
                imageUrl={analysedImageUrl}
                setDecisionOverride={setDecisionOverride}
                setItemExcluded={setItemExcluded}
                correctLabel={correctLabel}
                correctingItemId={correctingItemId}
                correctionError={correctionError}
                enableBackToTop
                filterRequest={filterRequest}
              />
              <DecisionActionBar
                totalCount={decideItemCount}
                counts={counts}
                backLabel="Back to Analyse space"
                onBack={() => goToStep("analyse")}
                backDisabled={wizard.navigationLocked}
                continueLabel="Continue to Confirm choices"
                onContinue={handleContinue}
                continueDisabled={!wizard.canContinueFromReview || wizard.navigationLocked}
                blockedReason={describeContinueBlocker({
                  hasAnalysis,
                  navigationLocked: wizard.navigationLocked,
                  correctingItemId,
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
                confirmationStatus={confirmationStatus}
                confirmationError={confirmationError}
                onConfirm={confirm}
                confirmation={confirmation}
                reviewItems={reviewItems}
                imageUrl={analysedImageUrl}
                onEditCategory={handleEditCategory}
                onReviewUnresolved={() => goToStep("review")}
              />

              <WizardNav
                backLabel="Back to Decide items"
                onBack={() => goToStep("review")}
                backDisabled={wizard.navigationLocked}
                // Current confirmation unlocks navigation only; generation stays explicit.
                continueLabel="Continue to Results"
                onContinue={confirmationStatus === "confirmed" && confirmation ? handleContinue : undefined}
                continueDisabled={!(viewed === "confirm" && wizard.canContinue)}
              />
            </div>
          )}
        </div>

        <div hidden={viewed !== "listings"}>
          {hasAnalysis && (
            <div className="space-y-6">
              {confirmationStatus === "confirmed" && confirmation ? (
                <DeclutterResultsSummary
                  confirmation={confirmation}
                  reviewItems={reviewItems}
                  imageUrl={analysedImageUrl}
                  onEditDecisions={() => handleEditCategory("all")}
                />
              ) : null}

              <ListingsView
                confirmation={confirmation}
                reviewItems={reviewItems}
                imageUrl={analysedImageUrl}
                listingStatus={listingStatus}
                listingDrafts={listingDrafts}
                listingError={listingError}
                regeneratingItemId={regeneratingItemId}
                regenerationError={regenerationError}
                generateListingDrafts={generateListingDrafts}
                regenerateListingDraft={regenerateListingDraft}
                editListingDraft={editListingDraft}
                discardListingDraft={discardListingDraft}
                restoreListingDraft={restoreListingDraft}
                listingDetailsById={listingDetailsById}
                setListingDetails={setListingDetails}
                missingListingItemIds={missingListingItemIds}
              />

              <div aria-label="Declutter actions" role="group" className="border-t border-border pt-6">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleStartOver}
                  disabled={wizard.navigationLocked}
                  className="min-h-11 w-full sm:min-h-0 sm:w-auto"
                >
                  <RotateCcw aria-hidden="true" width={14} height={14} />
                  Start over
                </Button>
                <WizardNav
                  backLabel="Back to Confirm choices"
                  onBack={() => goToStep("confirm")}
                  backDisabled={wizard.navigationLocked}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
