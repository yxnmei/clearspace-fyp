import { useState } from "react";
import { ArrowRight, Check, ShieldCheck, Star } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";
import declutterIcon from "../assets/declutter.svg";
import reorganiseIcon from "../assets/reorganise.svg";
import bothIcon from "../assets/both.svg";

// Top-level workflow entry point. Presentational apart from a single piece of
// local UI state: which card is currently selected in the radio group.
// App.jsx still owns the real `mode` state, this component only calls
// onChoose("declutter" | "reorganise" | "both") once, when Continue is
// pressed.
//
// The three cards are ONE native radio group (name="workflow"), so keyboard
// selection is the browser's own arrow-key behaviour and nothing here
// re-implements it. Continue stays disabled until a workflow is chosen, and
// decorative card content never navigates on its own.
const WORKFLOWS = [
  {
    value: "declutter",
    title: "Declutter",
    iconSrc: declutterIcon,
    description:
      "Get AI Keep, Sell, Donate and Discard suggestions for what's in your room, then review, change and confirm every decision yourself.",
    footnote: "Best for quick item decisions",
  },
  {
    value: "reorganise",
    title: "Reorganise",
    iconSrc: reorganiseIcon,
    description:
      "Actionable items are included automatically. Optionally review the list to exclude items before generating a prioritised reorganisation checklist and an AI visual preview.",
    footnote: "Best for space planning",
  },
  {
    value: "both",
    title: "Both",
    iconSrc: bothIcon,
    wideIcon: true,
    recommended: true,
    description:
      "Confirm your Declutter decisions first, then reorganise using only the items you confirmed as Keep.",
    footnote: "Best for full end-to-end guidance",
  },
];

export default function PathSelector({ onChoose }) {
  const [selected, setSelected] = useState(null);

  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="text-center">
        <h1 className="text-title font-semibold tracking-tight text-foreground sm:text-display">
          Let's get your space working for you
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Choose a workflow to declutter a room, reorganise it, or do both in one guided pass.
        </p>
      </div>

      <fieldset className="mt-10">
        <legend className="mb-4 w-full text-center text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Choose a workflow
        </legend>

        <div className="grid gap-4 lg:grid-cols-3">
          {WORKFLOWS.map(({ value, title, iconSrc, wideIcon, description, footnote, recommended }) => {
            const isSelected = selected === value;
            return (
              <label
                key={value}
                className="group relative block h-full cursor-pointer"
              >
                <input
                  type="radio"
                  name="workflow"
                  value={value}
                  checked={isSelected}
                  onChange={() => setSelected(value)}
                  aria-label={title}
                  aria-describedby={`workflow-${value}-desc`}
                  className="peer sr-only"
                />
                <div
                  className={cn(
                    "relative flex h-full flex-col rounded-card border-2 bg-surface p-5 text-left shadow-card transition-colors",
                    "group-hover:border-primary/40",
                    isSelected ? "border-primary bg-accent/40" : "border-border",
                    "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
                  )}
                >
                  {recommended ? (
                    <Badge variant="primary" className="absolute right-3 top-3">
                      <Star aria-hidden="true" width={12} height={12} />
                      Recommended
                    </Badge>
                  ) : null}

                  <span aria-hidden="true" className="flex h-28 w-full items-center justify-center">
                    <img
                      src={iconSrc}
                      alt=""
                      aria-hidden="true"
                      className={cn(
                        "block max-h-24 object-contain",
                        wideIcon ? "w-40 max-w-full" : "w-24"
                      )}
                    />
                  </span>

                  <span className="mt-4 flex items-center gap-2 text-lg font-semibold text-foreground">
                    {title}
                    <Check
                      aria-hidden="true"
                      width={18}
                      height={18}
                      className={cn("text-primary", isSelected ? "opacity-100" : "opacity-0")}
                    />
                  </span>

                  <span id={`workflow-${value}-desc`} className="mt-2 flex-1 text-sm text-muted-foreground">
                    {description}
                  </span>

                  <span className="mt-4 flex items-center gap-1.5 border-t border-border pt-3 text-xs font-medium text-foreground">
                    <Check aria-hidden="true" width={14} height={14} className="text-primary" />
                    {footnote}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-8 flex flex-col items-center gap-4">
        <Button
          type="button"
          size="lg"
          disabled={selected === null}
          onClick={() => selected !== null && onChoose(selected)}
        >
          Continue
          <ArrowRight aria-hidden="true" width={18} height={18} />
        </Button>

        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden="true" width={16} height={16} className="text-primary" />
          You're in control. Every AI suggestion is yours to review and change before anything is finalised.
        </p>
      </div>
    </section>
  );
}
