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

// The Declutter workflow as a five-view wizard: Upload → Analyse →
// Review → Confirm → Listings. useDeclutterFlow stays the sole owner of
// analysis, decisions, confirmation, listing state/actions, concurrency
// and API activity; this component adds only presentation state, which
// step is being viewed, and whether the user has acknowledged Review by
// pressing Continue to Confirm choices.
//
// All five views stay mounted (the non-viewed ones `hidden`, so they are
// out of the accessibility tree and unfocusable) purely so DeclutterUploadForm's
// picked file/context and the review workspace's local UI state survive
// moving between views. Navigation never touches the network, it is
// setViewedStep and nothing else. lib/declutterWizard derives the
// unlocking rules; lib/declutterReview derives the partition, counts and
// the confirmation guard. Listings is the standalone-Declutter run's
// final step, this workflow never continues into Reorganise, unlike Both.
//
// submittedFile is captured at the moment submit() is actually called and
// drives a separate object-URL lifecycle (useObjectUrl) from
// DeclutterUploadForm's own picker preview, so the analysed-room image
// is always the one that was analysed, never whatever the form shows
// after. The same object URL is reused as ListingsView's imageUrl, so
// listing draft cards crop from the identical analysed photo.
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

  // The Analyse view's own heading exists only while the request is
  // running or has failed; a successful analysis is headed by the
  // summary's "What we found" instead (the tracker already announces
  // completion), so the page never shows the same state twice.
  const analyseHeading = status === "error" ? "Analysis unsuccessful" : "Analysing your space";
  const showAnalyseHeading = !(status === "ready" && hasAnalysis);

  // Eligibility is derived the SAME way ListingsView derives it (both
  // consume lib/listingDrafts.js's deriveEligibleSellItemIds), strictly
  // from confirmation.confirmedDecisions: confirmed_decision === "sell"
  // && excluded === false. Never labels, draft presence or Keep ids.
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
      setSubmittedFile(file); // capture the analysed image now
      setConfirmAcknowledged(false); // a new upload relocks Review + Confirm
      setViewedStep("analyse"); // move to Analyse immediately
      return submit({ file, context });
    },
    [submit]
  );

  const goToStep = useCallback(
    (stepId) => {
      // The tracker/controls only offer unlocked, non-locked targets, but
      // guard here too so a stale click can never jump to a locked step.
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

  // A per-category Edit link on Confirm (or Edit decisions on Results)
  // navigates to Decide items with that decision filter applied. Only
  // presentation: no decision changes here, and the review section owns
  // the filter afterwards. The nonce lets the same filter be requested
  // twice in a row.
  const [filterRequest, setFilterRequest] = useState(null);
  const handleEditCategory = useCallback(
    (filterId) => {
      setFilterRequest((previous) => ({ id: filterId, nonce: (previous?.nonce ?? 0) + 1 }));
      goToStep("review");
    },
    [goToStep]
  );

  // Start over from the closing Listing drafts view: the hook's reset
  // clears analysis, decisions, confirmation and listing state (and
  // relocks every step), and the page drops its own presentation state
  // and the analysed-image URL, returning to Upload photo.
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
        {/* ---------- Upload ---------- */}
        <div hidden={viewed !== "upload"}>
          <p className="mb-4 max-w-2xl text-muted-foreground">
            Get a suggested action for every item, then review and confirm each one.
          </p>
          <DeclutterUploadForm status={status} error={error} onSubmit={handleSubmit} />
        </div>

        {/* ---------- Analyse ---------- */}
        <div hidden={viewed !== "analyse"}>
          <section className="space-y-4">
            {showAnalyseHeading && (
              <h2 className="text-title font-semibold tracking-tight text-foreground">{analyseHeading}</h2>
            )}

            {/* One hierarchy per state: the heading above says which
                state this is, so each panel is a single calm line. */}
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

            {/* Success renders no heading or banner of its own: the tracker's
                live status line already says "Analysis complete." and names
                the next action, and the summary below supplies the screen's
                single visible h2. */}
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

        {/* ---------- Review ---------- */}
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
              {/* The sticky summary bar is this view's ONLY Back / Continue
                  pair. The Continue guard is unchanged; the bar just says
                  why it is disabled. */}
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

        {/* ---------- Confirm ---------- */}
        <div hidden={viewed !== "confirm"}>
          {hasAnalysis && (
            <div className="space-y-6">
              {/* One panel for every confirmation state; it turns into the
                  success summary in place. "Review unresolved items" is
                  plain step navigation back to Decide items. */}
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
                // Continue to Listings appears only once there is a
                // successful CURRENT confirmation (not merely disabled
                // before then, unlike Review's Continue) and only ever
                // navigates, it never calls generateListingDrafts itself,
                // generation stays an explicit action on the Listings
                // view (ListingsView's own "Generate listing drafts"
                // button).
                continueLabel="Continue to Results"
                onContinue={confirmationStatus === "confirmed" && confirmation ? handleContinue : undefined}
                continueDisabled={!(viewed === "confirm" && wizard.canContinue)}
              />
            </div>
          )}
        </div>

        {/* ---------- Listings ---------- */}
        <div hidden={viewed !== "listings"}>
          {hasAnalysis && (
            <div className="space-y-6">
              {/* The closing overview of a standalone Declutter run: counts
                  first, the item chips collapsed behind one control, and
                  Edit decisions back to Decide items. The listings below
                  are the primary content. It renders only with a current
                  successful confirmation, which is also the only way this
                  view unlocks. */}
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

              {/* Start over is the one whole-workflow reset on this page,
                  offered only here, at the end, beside the wizard's Back. */}
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
