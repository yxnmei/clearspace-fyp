import { Loader2, PackageCheck, Tag, HandHeart, Trash2, PencilLine, EyeOff, CircleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

// The "4. Confirm decisions" section: the derived-count summary, the
// confirm button and the blocked/failed messages. Every count and the
// disabled flag are computed in DeclutterReview and passed in; `onConfirm`
// is DeclutterReview's own `confirm` prop, forwarded unchanged.
function Count({ icon: Icon, label, value, tone = "default" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-control border border-border bg-surface-muted px-3 py-2",
        tone === "alert" && value > 0 && "border-error/40 bg-error/10"
      )}
    >
      <Icon
        aria-hidden="true"
        width={15}
        height={15}
        className={cn("shrink-0", tone === "alert" && value > 0 ? "text-error" : "text-primary")}
      />
      <div>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-sm font-semibold text-foreground">{value}</dd>
      </div>
    </div>
  );
}

export default function DeclutterConfirmationPanel({
  counts,
  changedCount,
  excludedCount,
  unresolvedCount,
  confirmDisabled,
  confirmationStatus,
  confirmationError,
  onConfirm,
}) {
  const isConfirming = confirmationStatus === "confirming";
  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
      <h2 className="mb-3 text-lg font-semibold text-foreground">4. Confirm decisions</h2>
      <dl className="mb-4 grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-4">
        <Count icon={PackageCheck} label="Keep" value={counts.keep} />
        <Count icon={Tag} label="Sell" value={counts.sell} />
        <Count icon={HandHeart} label="Donate" value={counts.donate} />
        <Count icon={Trash2} label="Discard" value={counts.discard} />
        <Count icon={PencilLine} label="Changed" value={changedCount} />
        <Count icon={EyeOff} label="Excluded" value={excludedCount} />
        <Count icon={CircleAlert} label="Unresolved" value={unresolvedCount} tone="alert" />
      </dl>

      <Button
        type="button"
        onClick={onConfirm}
        disabled={confirmDisabled}
        aria-busy={isConfirming || undefined}
      >
        {isConfirming && <Loader2 aria-hidden="true" width={16} height={16} className="animate-spin" />}
        {isConfirming ? "Confirming…" : "Confirm decisions"}
      </Button>

      {unresolvedCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Resolve every unresolved item above before confirmation is available.
        </p>
      )}

      {confirmationStatus === "error" && confirmationError && (
        <p
          role="alert"
          className="mt-3 rounded-control border border-error/30 bg-error/10 p-3 text-sm text-error"
        >
          {confirmationError} Your review decisions and exclusions are unchanged. You can try again.
        </p>
      )}
    </section>
  );
}
