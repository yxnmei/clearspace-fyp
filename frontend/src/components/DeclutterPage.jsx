import { useCallback, useState } from "react";
import { useDeclutterFlow } from "../hooks/useDeclutterFlow";
import { useObjectUrl } from "../hooks/useObjectUrl";
import DeclutterUploadForm from "./DeclutterUploadForm";
import DeclutterReview from "./DeclutterReview";

// Top-level Declutter workflow — all real state/orchestration lives in
// useDeclutterFlow (§4); this component only wires that state to the two
// screen sections and never calls the API directly.
//
// submittedFile/analysedImageUrl are a SEPARATE object-URL lifecycle from
// DeclutterUploadForm's own picker preview, deliberately not shared —
// DeclutterUploadForm's file input stays interactive after a successful
// analysis, so a user picking a new photo while reviewing a previous
// result must not retroactively change the image the analysed-room panel
// (in DeclutterReview) is showing boxes over. Capturing the file at the
// moment submit() is actually called, independently of whatever the form
// shows afterward, keeps "the image under review" correct regardless of
// what the user does in the form next. See useObjectUrl for the
// create/revoke lifecycle itself.
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

  const [submittedFile, setSubmittedFile] = useState(null);
  const analysedImageUrl = useObjectUrl(submittedFile);

  const handleSubmit = useCallback(
    ({ file, context }) => {
      setSubmittedFile(file);
      return submit({ file, context });
    },
    [submit]
  );

  return (
    <div>
      <DeclutterUploadForm status={status} error={error} onSubmit={handleSubmit} />

      {analysis && declutter && (
        <DeclutterReview
          analysis={analysis}
          declutter={declutter}
          reviewItems={reviewItems}
          imageUrl={analysedImageUrl}
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
