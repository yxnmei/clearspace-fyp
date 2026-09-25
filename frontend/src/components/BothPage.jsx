import { useCallback, useState } from "react";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useBothFlow } from "../hooks/useBothFlow";
import { useImageGenHealth } from "../hooks/useImageGenHealth";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { deriveBothProgress } from "../lib/workflowProgress";
import {
  partitionReviewItems,
  deriveReviewCounts,
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
import DeclutterResultsSummary from "./DeclutterResultsSummary";
import ReorganiseResult from "./ReorganiseResult";
import ListingsView from "./ListingsView";
import { Button } from "./ui/button";

const NEXT_STEP_NOTE =
  "On the Results screen, Tidy up and Marketplace listings are separate actions. Neither starts automatically, and you can run either first.";

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
  const { resolvedItems, unresolvedItems } = partitionReviewItems(flow.reviewItems);
  const { counts, changedCount, excludedCount } = deriveReviewCounts(resolvedItems);
  const unresolvedCount = unresolvedItems.length;
  const decideItemCount = resolvedItems.length + unresolvedCount;
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

  // Same as DeclutterPage: Edit links on Confirm and Results navigate to
  // Decide items with a decision filter applied; nothing here changes a
  // decision, and the review section owns the filter afterwards.
  const [filterRequest, setFilterRequest] = useState(null);
  const handleEditCategory = useCallback(
    (filterId) => {
      setFilterRequest((previous) => ({ id: filterId, nonce: (previous?.nonce ?? 0) + 1 }));
      goToStep("review");
    },
    [goToStep]
  );

  const handleStartOver = useCallback(() => {
    flow.reset();
    setReviewAcknowledged(false);
    setViewedStep("upload");
  }, [flow.reset]);

  // The Analyse view's own heading exists only while the request is
  // running or has failed; a successful analysis is headed by the
  // summary's "What we found" instead (the tracker already announces
  // completion), so the page never shows the same state twice.
  const analyseHeading = flow.status === "error" ? "Analysis unsuccessful" : "Analysing your space";
  const showAnalyseHeading = !(flow.status === "ready" && hasAnalysis);

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

      <div className="mt-4">
        <div hidden={viewed !== "upload"}>
          <p className="mb-4 max-w-2xl text-muted-foreground">
            Review suggested decisions, then create a tidy plan and listing drafts from your confirmed choices.
          </p>
          <DeclutterUploadForm status={flow.status} error={flow.error} onSubmit={handleSubmit} />
        </div>

        <div hidden={viewed !== "analyse"}>
          <section className="space-y-4">
            {showAnalyseHeading && (
              <h2 className="text-title font-semibold tracking-tight text-foreground">{analyseHeading}</h2>
            )}

            {/* One hierarchy per state: the heading above says which
                state this is, so each panel is a single calm line. */}
            {flow.status === "uploading" && (
              <p
                role="status"
                className="flex items-center gap-2 rounded-card border border-border bg-surface-muted p-4 text-sm text-foreground"
              >
                <Loader2 aria-hidden="true" width={16} height={16} className="shrink-0 animate-spin text-primary" />
                Finding items and preparing your next step. This may take up to two minutes.
              </p>
            )}

            {flow.status === "error" && flow.error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-card border border-error/30 bg-error/10 p-4 text-sm text-error"
              >
                <TriangleAlert aria-hidden="true" width={16} height={16} className="mt-0.5 shrink-0" />
                <span>
                  {flow.error} Your selected photo and context are still on Upload photo. Go back to Upload photo and
                  try again.
                </span>
              </p>
            )}

            {/* Success renders no heading or banner of its own: the tracker's
                live status line already says "Analysis complete." and names
                the next action, and the summary below supplies the screen's
                single visible h2. */}
            {hasAnalysis && <DeclutterAnalysisSummary analysis={flow.analysis} declutter={flow.declutter} />}

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
                filterRequest={filterRequest}
              />
              {/* Same shared bar as the Declutter wizard: the only Back /
                  Continue pair on this screen, guard unchanged. */}
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
              {/* The same single panel as the Declutter wizard, with Both's
                  own next-step note. */}
              <DeclutterConfirmationPanel
                counts={counts}
                changedCount={changedCount}
                excludedCount={excludedCount}
                unresolvedCount={unresolvedCount}
                confirmDisabled={confirmDisabled}
                confirmationStatus={flow.confirmationStatus}
                confirmationError={flow.confirmationError}
                onConfirm={flow.confirm}
                confirmation={flow.confirmation}
                reviewItems={flow.reviewItems}
                imageUrl={imageUrl}
                onEditCategory={handleEditCategory}
                onReviewUnresolved={() => goToStep("review")}
                nextStepNote={NEXT_STEP_NOTE}
              />

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
            <div className="space-y-8">
              {/* The compact Declutter overview first: counts, the item
                  chips collapsed behind one control, Edit decisions back to
                  Decide items. Tidy up and Marketplace listings, the two
                  result actions, follow it unchanged. */}
              <DeclutterResultsSummary
                confirmation={flow.confirmation}
                reviewItems={flow.reviewItems}
                imageUrl={imageUrl}
                onEditDecisions={() => handleEditCategory("all")}
                intro="Your decisions are confirmed. Tidy up uses the items you kept; listings use the items you chose to sell."
              />

              {/* Results composition (brief §15): two visually and
                  semantically distinct result sections, Tidy up (confirmed
                  Keep items) then Marketplace listings (confirmed Sell
                  items), then the global actions. No introduction: the
                  stepper's status line already says both are available in
                  either order. The two sections are independent: each owns
                  its own button, busy state and error, nothing here derives
                  a shared one, and neither starts on its own. */}
              {flow.generateResult ? (
                /* The generated result IS the Tidy up section: its own
                   heading, checklist, visual preview (including its own
                   "unavailable" state, so no separate health banner is
                   shown beside it) and storage ideas. No onStartOver: the
                   single global Start over lives after both sections. */
                <ReorganiseResult
                  heading="Tidy up"
                  generateResult={flow.generateResult}
                  originalImageUrl={imageUrl}
                />
              ) : (
                <section
                  aria-labelledby="both-tidy-up-heading"
                  className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
                >
                  <h2 id="both-tidy-up-heading" className="text-title font-semibold tracking-tight text-foreground">
                    Tidy up
                  </h2>
                  {flow.confirmation.confirmedKeepIds.length === 0 ? (
                    <div className="mt-3 rounded-control border border-border bg-surface-muted p-4 text-sm text-muted-foreground">
                      <p>You did not confirm any items as Keep, so there is nothing to include in a tidy plan.</p>
                      <p className="mt-1">Marketplace listings below remain available for the items you confirmed as Sell.</p>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
                        Create a prioritised checklist, relevant storage and organisation ideas and an optional visual
                        preview from the {flow.confirmation.confirmedKeepIds.length} item
                        {flow.confirmation.confirmedKeepIds.length === 1 ? "" : "s"} you confirmed as Keep.
                      </p>
                      {/* The image-service notice belongs to Tidy up only (it
                          is the visual preview that needs the service), so it
                          sits here, inside this section, and is the ONE
                          notice: the banner renders nothing when the service
                          is available, and it never disables Create tidy
                          plan, the checklist completes without the preview. */}
                      <div className="mt-3 empty:hidden">
                        <ImageGenStatusBanner status={health.status} recheck={health.recheck} />
                      </div>
                      <Button
                        type="button"
                        className="mt-4 min-h-11 w-full sm:min-h-0 sm:w-auto"
                        onClick={flow.generate}
                        disabled={flow.generationStatus === "generating"}
                        aria-busy={flow.generationStatus === "generating" || undefined}
                      >
                        {flow.generationStatus === "generating" && (
                          <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />
                        )}
                        {flow.generationStatus === "generating"
                          ? "Creating tidy plan…"
                          : flow.generateError
                            ? "Try again"
                            : "Create tidy plan"}
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
                listingDetailsById={flow.listingDetailsById}
                setListingDetails={flow.setListingDetails}
                missingListingItemIds={flow.missingListingItemIds}
              />

              {/* Global actions, after BOTH result sections: the one Start
                  over for the whole Both workflow (the same full reset as
                  before; ReorganiseResult no longer carries one here), then
                  the wizard's Back as the final control. */}
              <div aria-label="Results actions" role="group" className="border-t border-border pt-6">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleStartOver}
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
