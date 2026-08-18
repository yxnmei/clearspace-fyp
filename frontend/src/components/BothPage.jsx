import { useBothFlow } from "../hooks/useBothFlow";
import { useImageGenHealth } from "../hooks/useImageGenHealth";
import { useObjectUrl } from "../hooks/useObjectUrl";
import ImageGenStatusBanner from "./ImageGenStatusBanner";
import DeclutterUploadForm from "./DeclutterUploadForm";
import DeclutterReview from "./DeclutterReview";
import ReorganiseResult from "./ReorganiseResult";

// Top-level Both workflow (R6) — composes DeclutterUploadForm/
// DeclutterReview (Declutter's own, unmodified presentational
// components) with ReorganiseResult (Direct Reorganise's own, unmodified
// result screen). No second item-selection screen exists anywhere in
// this page — ReorganiseItemSelector is never imported here at all;
// "which items to keep" is answered entirely by Declutter's own Keep/
// Sell/Donate/Discard review, exactly as PROJECT_SPEC's Both-workflow
// design requires.
//
// THE ONE owner of useImageGenHealth() for this page (same discipline as
// ReorganisePage) — ImageGenStatusBanner receives {status, recheck} as
// props, never calling the hook itself, so mounting this page issues
// exactly one GET /image-gen/health request. Advisory only: the banner
// never disables the Continue-to-reorganisation action below — Both, like
// Direct Reorganise, always plans first and accepts image_status=
// "unavailable" as a complete, successful result when Colab is offline.
//
// useObjectUrl(flow.file) reuses the existing, unchanged, already-tested
// hook — flow.file is retained by useBothFlow for the WHOLE flow (upload
// -> review -> confirm -> generate -> result), unlike DeclutterPage's own
// page-level submittedFile pattern, since useBothFlow needs the original
// bytes again at generate() time. The same object URL therefore serves
// BOTH DeclutterReview's analysed-room panel and, later, ReorganiseResult's
// "before" image, revoked/replaced exactly when flow.file changes (a new
// upload, or reset() setting it back to null) — mirroring ReorganisePage's
// identical convention.
//
// Confirmation is never auto-chained into generation: confirm() (via
// DeclutterReview's own "Confirm decisions" button) and generate() (via
// this page's own "Continue to reorganisation" button, below) are two
// separate, explicit user actions. The Continue button/empty-Keep message
// only appears once confirmationStatus === "confirmed" — before that,
// there is nothing to continue to.
const NEXT_STEP_NOTE =
  "These confirmed Keep items will be sent to reorganisation next — nothing is generated automatically.";

export default function BothPage({ onBackToPathSelection }) {
  const flow = useBothFlow();
  const health = useImageGenHealth();
  const imageUrl = useObjectUrl(flow.file);

  const hasConfirmation = flow.confirmationStatus === "confirmed" && flow.confirmation !== null;
  const hasConfirmedKeep = hasConfirmation && flow.confirmation.confirmedKeepIds.length > 0;
  const hasConfirmedEmptyKeep = hasConfirmation && flow.confirmation.confirmedKeepIds.length === 0;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToPathSelection}
          className="text-sm text-stone-600 underline hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
        >
          ← Back to workflow selection
        </button>
      </div>

      <ImageGenStatusBanner status={health.status} recheck={health.recheck} />

      <div className="mt-4">
        {flow.generateResult === null ? (
          <>
            <DeclutterUploadForm
              status={flow.status}
              error={flow.error}
              onSubmit={(payload) => flow.submit(payload)}
            />

            {flow.analysis && flow.declutter && (
              <DeclutterReview
                analysis={flow.analysis}
                declutter={flow.declutter}
                reviewItems={flow.reviewItems}
                imageUrl={imageUrl}
                setDecisionOverride={flow.setDecisionOverride}
                setItemExcluded={flow.setItemExcluded}
                confirm={flow.confirm}
                confirmationStatus={flow.confirmationStatus}
                confirmationError={flow.confirmationError}
                confirmation={flow.confirmation}
                correctLabel={flow.correctLabel}
                correctingItemId={flow.correctingItemId}
                correctionError={flow.correctionError}
                confirmationNextStepNote={NEXT_STEP_NOTE}
              />
            )}

            {hasConfirmation && (
              <section className="mt-6 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
                {hasConfirmedEmptyKeep ? (
                  <p className="text-sm text-stone-600">
                    No items were confirmed as Keep — there is nothing to reorganise. Go back and confirm at least
                    one Keep item to continue.
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={flow.generate}
                      disabled={flow.generationStatus === "generating"}
                      className="rounded-md bg-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-stone-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
                    >
                      {flow.generationStatus === "generating"
                        ? "Generating…"
                        : flow.generationStatus === "error"
                          ? "Retry reorganisation"
                          : "Continue to reorganisation"}
                    </button>

                    {flow.generationStatus === "generating" && (
                      <p role="status" className="mt-3 flex items-center gap-2 text-sm text-stone-600">
                        <span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-green-700" />
                        Planning the reorganisation and generating a visual preview. This may take up to two minutes
                        on this computer.
                      </p>
                    )}

                    {flow.generationStatus === "error" && flow.generateError && (
                      <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                        {flow.generateError} Your confirmed decisions are unchanged — you can try again.
                      </p>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        ) : (
          <ReorganiseResult
            generateResult={flow.generateResult}
            items={flow.items}
            originalImageUrl={imageUrl}
            onStartOver={flow.reset}
          />
        )}
      </div>
    </div>
  );
}
