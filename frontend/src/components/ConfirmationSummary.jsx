import { CheckCircle2, PackageCheck, Tag, HandHeart, Trash2, PencilLine, EyeOff } from "lucide-react";
import { cn } from "../lib/cn";

// Renders the normalized ConfirmationResult from useDeclutterFlow's
// confirmation state. Confirmed Keep item_ids are matched back to
// reviewItems strictly by item_id, never by label, so this component
// can show a clean_label/position next to each confirmed Keep item.
//
// nextStepNote: optional. Defaults to the standalone-Declutter wording
// below (DeclutterReview does not pass it there). Standalone Declutter
// cannot continue into Reorganise, so the default note only states what
// was confirmed and promises nothing about a later stage. Both passes
// its own note, since for Both, Reorganise is the immediate next step of
// the same flow rather than a separate workflow the user might start later.
function Count({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2 rounded-control border border-success/30 bg-surface px-3 py-2">
      <Icon aria-hidden="true" width={15} height={15} className="shrink-0 text-success" />
      <div>
        <dt className="text-xs text-success">{label}</dt>
        <dd className="text-sm font-semibold text-foreground">{value}</dd>
      </div>
    </div>
  );
}

export default function ConfirmationSummary({
  confirmation,
  reviewItems,
  nextStepNote = "These are the items you confirmed to keep.",
}) {
  const counts = { keep: 0, sell: 0, donate: 0, discard: 0 };
  for (const decision of confirmation.confirmedDecisions) {
    counts[decision.confirmed_decision] += 1;
  }

  const reviewItemsById = new Map(reviewItems.map((item) => [item.item_id, item]));
  const keepItems = confirmation.confirmedKeepIds.map((itemId) => ({
    item_id: itemId,
    matched: reviewItemsById.get(itemId) ?? null,
  }));

  const decisionCount = confirmation.confirmedDecisions.length;

  return (
    <section className="rounded-card border border-success/40 bg-success/5 p-5 shadow-card sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-success">
        <CheckCircle2 aria-hidden="true" width={20} height={20} />
        Decisions confirmed
      </h2>
      <p role="status" className="mb-4 mt-1 text-sm text-foreground">
        Run {confirmation.runId}, {decisionCount} decision
        {decisionCount === 1 ? "" : "s"} confirmed.
      </p>

      <dl className="mb-4 grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-3">
        <Count icon={PackageCheck} label="Keep" value={counts.keep} />
        <Count icon={Tag} label="Sell" value={counts.sell} />
        <Count icon={HandHeart} label="Donate" value={counts.donate} />
        <Count icon={Trash2} label="Discard" value={counts.discard} />
        <Count icon={PencilLine} label="Changed from AI" value={confirmation.decisionChangedCount} />
        <Count icon={EyeOff} label="Excluded" value={confirmation.excludedCount} />
      </dl>

      <h3 className="text-sm font-semibold text-success">Confirmed Keep items ({keepItems.length})</h3>
      <p className="mb-2 mt-1 text-sm text-foreground">{nextStepNote}</p>
      {keepItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No items were confirmed as Keep.</p>
      ) : (
        <ul className="space-y-1.5">
          {keepItems.map(({ item_id, matched }) => (
            <li
              key={item_id}
              className={cn(
                "rounded-control border border-success/30 bg-surface p-2 text-sm text-foreground"
              )}
            >
              <code>{item_id}</code>
              {matched && (
                <>
                  {", "}
                  {matched.effective_label ?? matched.clean_label}
                  {matched.position && <span className="text-muted-foreground"> ({matched.position})</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
