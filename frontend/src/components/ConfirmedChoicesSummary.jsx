import { useEffect, useRef, useState } from "react";
import { Copy, Pencil } from "lucide-react";
import { Button } from "./ui/button";
import ItemCropThumbnail from "./ItemCropThumbnail";
import ImageLightbox from "./ImageLightbox";
import { itemNumberLabel } from "../utils/format";
import { cn } from "../lib/cn";

// Read-only confirmed groups joined strictly by item_id. Edit links return to
// filtered review. Copy starts synchronously and only the newest mounted
// attempt may set fixed, display-safe feedback.

const SUMMARY_GROUPS = [
  ["keep", "Keep"],
  ["sell", "Sell"],
  ["donate", "Donate"],
  ["discard", "Discard"],
  ["excluded", "Excluded"],
];

// Excluded items span decisions, so that group opens the full list.
const GROUP_FILTER = {
  keep: "keep",
  sell: "sell",
  donate: "donate",
  discard: "discard",
  excluded: "all",
};

function defaultClipboardWriter(text) {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard API unavailable"));
}

export function summaryRows(confirmation, reviewItems) {
  const byId = new Map(reviewItems.map((item) => [item.item_id, item]));
  return SUMMARY_GROUPS.map(([value, title]) => ({
    value,
    title,
    entries: confirmation.confirmedDecisions
      .filter((decision) =>
        value === "excluded" ? decision.excluded : !decision.excluded && decision.confirmed_decision === value
      )
      .map((decision) => {
        const item = byId.get(decision.item_id);
        return { decision, item, label: item?.display_label ?? item?.effective_label ?? item?.clean_label ?? "Item" };
      }),
  })).filter((group) => group.entries.length > 0);
}

// Count repeated labels without guessing plurals.
export function copySummaryText(groups) {
  return groups
    .map(({ title, entries }) => {
      const counts = new Map();
      for (const { label } of entries) counts.set(label, (counts.get(label) ?? 0) + 1);
      const labels = [...counts].map(([label, count]) => (count === 1 ? label : `${label} (${count})`));
      return `${title}: ${labels.join(", ")}`;
    })
    .join("\n");
}

export default function ConfirmedChoicesSummary({
  confirmation,
  reviewItems = [],
  imageUrl = null,
  clipboardWriter = defaultClipboardWriter,
  onEditCategory,
  label = "Confirmed choices summary",
  className,
}) {
  const [copyState, setCopyState] = useState("idle");
  const [enlargedItemId, setEnlargedItemId] = useState(null);
  const copyTokenRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyTokenRef.current += 1;
    };
  }, []);
  useEffect(() => {
    copyTokenRef.current += 1;
    setCopyState("idle");
  }, [confirmation]);

  const groups = summaryRows(confirmation, reviewItems);
  const enlarged = enlargedItemId === null ? null : reviewItems.find((item) => item.item_id === enlargedItemId) ?? null;

  function handleCopy() {
    const token = (copyTokenRef.current += 1);
    setCopyState("idle");
    const current = () => mountedRef.current && copyTokenRef.current === token;
    try {
      const result = clipboardWriter(copySummaryText(groups));
      Promise.resolve(result).then(
        () => {
          if (current()) setCopyState("copied");
        },
        () => {
          if (current()) setCopyState("error");
        }
      );
    } catch {
      if (current()) setCopyState("error");
    }
  }

  return (
    <div className={className}>
      <div className="space-y-4" aria-label={label}>
        {groups.map((group) => (
          <section key={group.value}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
              {onEditCategory ? (
                <button
                  type="button"
                  onClick={() => onEditCategory(GROUP_FILTER[group.value])}
                  aria-label={`Edit ${group.title} decisions`}
                  className="inline-flex items-center gap-1 rounded-control text-xs font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Pencil aria-hidden="true" width={12} height={12} />
                  Edit
                </button>
              ) : null}
            </div>
            {/* Chips wrap inline so fifteen items take a few lines, not a
                screen. Each chip is one button (the whole list item is its
                target) that opens the photo with this item outlined; the
                thumbnail is decorative and the label is the visible text. A
                changed decision gets an amber ring plus a screen-reader-only
                word, so the marker is never colour alone. */}
            <ul className="mt-2 flex flex-wrap gap-2" aria-label={`${group.title} items`}>
              {group.entries.map(({ decision, item, label: itemLabel }) => (
                <li key={decision.item_id}>
                  <button
                    type="button"
                    onClick={() => setEnlargedItemId(decision.item_id)}
                    disabled={!imageUrl || !item?.box}
                    aria-label={`Show ${itemLabel} in the photo`}
                    className={cn(
                      "inline-flex max-w-full items-center gap-2 rounded-pill border bg-surface py-1 pl-1 pr-3 text-sm text-foreground transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default disabled:hover:border-border",
                      decision.decision_changed ? "border-warning/70 ring-1 ring-warning/40" : "border-border"
                    )}
                  >
                    <ItemCropThumbnail imageUrl={imageUrl} box={item?.box} className="h-6 w-6 rounded-full" />
                    <span className="min-w-0 truncate">{itemLabel}</span>
                    {decision.decision_changed && (
                      <>
                        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warning" />
                        <span className="sr-only">Changed</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="mt-4">
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          <Copy aria-hidden="true" width={14} height={14} />
          Copy summary
        </Button>
        {copyState === "copied" && (
          <p role="status" className="mt-2 text-sm text-success">
            Summary copied to your clipboard.
          </p>
        )}
        {copyState === "error" && (
          <p role="status" className="mt-2 text-sm text-error">
            Could not copy the summary. Nothing has changed.
          </p>
        )}
      </div>

      {/* One lightbox for every chip: the original photo with only the
          chosen item's outline, highlighted. The Show boxes toggle still
          hides it; zoom is unchanged. */}
      {imageUrl ? (
        <ImageLightbox
          open={enlarged !== null}
          onClose={() => setEnlargedItemId(null)}
          src={imageUrl}
          alt="The space photo you uploaded"
          title={enlarged ? `${enlarged.display_label ?? enlarged.effective_label ?? enlarged.clean_label} in your photo` : "Your photo"}
          description="Only this item's outline is shown. Use Show boxes to hide it."
          overlays={
            enlarged && enlarged.box
              ? [
                  {
                    id: enlarged.item_id,
                    box: enlarged.box,
                    label: itemNumberLabel(enlarged.item_id),
                    className: "z-20 border-4 border-primary bg-primary/10 ring-2 ring-ring ring-offset-1",
                  },
                ]
              : null
          }
          initialShowOverlays
        />
      ) : null}
    </div>
  );
}
