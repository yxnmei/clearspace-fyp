import { useDeclutterFlow } from "../hooks/useDeclutterFlow";
import DeclutterUploadForm from "./DeclutterUploadForm";
import DeclutterReview from "./DeclutterReview";

// Top-level Declutter workflow — all real state/orchestration lives in
// useDeclutterFlow (§4); this component only wires that state to the two
// screen sections and never calls the API directly.
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
  } = useDeclutterFlow();

  return (
    <div>
      <DeclutterUploadForm status={status} error={error} onSubmit={submit} />

      {analysis && declutter && (
        <DeclutterReview
          analysis={analysis}
          declutter={declutter}
          reviewItems={reviewItems}
          setDecisionOverride={setDecisionOverride}
          setItemExcluded={setItemExcluded}
          confirm={confirm}
          confirmationStatus={confirmationStatus}
          confirmationError={confirmationError}
          confirmation={confirmation}
        />
      )}
    </div>
  );
}
