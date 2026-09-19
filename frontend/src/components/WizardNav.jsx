import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";

// The Back / Continue control row shared by the wizard views of every
// workflow. It only renders and disables buttons, the availability rules
// and the actual step change live in the pages / lib derivations.
//
// Layout: below sm the controls stack vertically, Back first, each one
// full width with its icon and label centred (the Button primitive already
// centres its content). From sm up they return to one row at their natural
// widths, Back on the left and Continue on the right; `sm:ml-auto` keeps
// Continue on the right even when there is no Back control, so no empty
// placeholder element is needed on either breakpoint.
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
