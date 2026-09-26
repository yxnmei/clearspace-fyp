import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";

// Shared presentational Back/Continue row; pages own availability and navigation.
export default function WizardNav({
  backLabel,
  onBack,
  backDisabled = false,
  continueLabel,
  onContinue,
  continueDisabled = false,
}) {
  return (
    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {onBack ? (
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={backDisabled}
          className="w-full sm:w-auto"
        >
          <ArrowLeft aria-hidden="true" width={16} height={16} />
          {backLabel}
        </Button>
      ) : null}

      {onContinue ? (
        <Button
          type="button"
          onClick={onContinue}
          disabled={continueDisabled}
          className="w-full sm:ml-auto sm:w-auto"
        >
          {continueLabel}
          <ArrowRight aria-hidden="true" width={16} height={16} />
        </Button>
      ) : null}
    </div>
  );
}
