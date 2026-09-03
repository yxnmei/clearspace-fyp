import DeclutterReviewSection from "./DeclutterReviewSection";
import DeclutterAnalysisSummary from "./DeclutterAnalysisSummary";
import DeclutterConfirmationPanel from "./DeclutterConfirmationPanel";
import ConfirmationSummary from "./ConfirmationSummary";
import {
  partitionReviewItems,
  deriveReviewCounts,
  totalStageDurationMs,
  isConfirmBlocked,
} from "../lib/declutterReview";

// The stacked Declutter review, analysis summary, the review workspace,
// the confirmation panel and (after success) the confirmed summary, all
// on one page. Direct Declutter now uses the four-view wizard instead;
// this composition is retained for Both, which still presents its
// Declutter phase stacked until its own wizard conversion.
//
// Every computation and the confirmation guard come from
// lib/declutterReview, so DeclutterReviewSection and this file never
// disagree about the partition, the counts or what blocks Confirm.
export default function DeclutterReview({
  analysis,
  declutter,
  reviewItems,
  imageUrl,
  setDecisionOverride,
  setItemExcluded,
  confirm,
  confirmationStatus,
  confirmationError,
  confirmation,
  correctLabel = () => {},
  correctingItemId = null,
  correctionError = null,
  // Forwarded to ConfirmationSummary's `nextStepNote`. Undefined by
  // default, so Declutter keeps ConfirmationSummary's standalone wording;
  // Both passes a note pointing at its immediate reorganisation step.
  confirmationNextStepNote,
}) {
  const { resolvedItems, unresolvedItems, contextualItems } = partitionReviewItems(reviewItems);
  const { counts, changedCount, excludedCount } = deriveReviewCounts(resolvedItems);
  const unresolvedCount = unresolvedItems.length;
  const totalDurationMs = totalStageDurationMs(analysis);

  const confirmDisabled = isConfirmBlocked({
    confirmationStatus,
    declutter,
    unresolvedCount,
    correctingItemId,
  });

  return (
    <div className="mt-6 space-y-6">
      <DeclutterAnalysisSummary
        analysis={analysis}
        declutter={declutter}
        contextualCount={contextualItems.length}
        totalDurationMs={totalDurationMs}
      />

      <DeclutterReviewSection
        reviewItems={reviewItems}
        imageUrl={imageUrl}
        setDecisionOverride={setDecisionOverride}
        setItemExcluded={setItemExcluded}
        correctLabel={correctLabel}
        correctingItemId={correctingItemId}
        correctionError={correctionError}
      />

      <DeclutterConfirmationPanel
        counts={counts}
        changedCount={changedCount}
        excludedCount={excludedCount}
        unresolvedCount={unresolvedCount}
        confirmDisabled={confirmDisabled}
        confirmationStatus={confirmationStatus}
        confirmationError={confirmationError}
        onConfirm={confirm}
      />

      {confirmation && (
        <ConfirmationSummary
          confirmation={confirmation}
          reviewItems={reviewItems}
          nextStepNote={confirmationNextStepNote}
        />
      )}
    </div>
  );
}
