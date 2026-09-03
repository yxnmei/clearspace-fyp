import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";

// The Back / Continue control row shared by the Declutter wizard's
// Analyse, Review and Confirm views. It only renders and disables
// buttons, the availability rules and the actual step change live in
// DeclutterPage / lib/declutterWizard.
export default function WizardNav({
  backLabel,
  onBack,
  backDisabled = false,
  continueLabel,
  onContinue,
  continueDisabled = false,
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      {onBack ? (
        <Button type="button" variant="outline" onClick={onBack} disabled={backDisabled}>
          <ArrowLeft aria-hidden="true" width={16} height={16} />
          {backLabel}
        </Button>
      ) : (
        <span />
      )}

      {onContinue ? (
        <Button type="button" onClick={onContinue} disabled={continueDisabled}>
          {continueLabel}
          <ArrowRight aria-hidden="true" width={16} height={16} />
        </Button>
      ) : null}
    </div>
  );
}
