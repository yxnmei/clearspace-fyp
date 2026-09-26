import { useState } from "react";
import { ArrowRight, Check, ShieldCheck, Star } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";
import declutterIcon from "../assets/declutter.svg";
import reorganiseIcon from "../assets/reorganise.svg";
import bothIcon from "../assets/both.svg";

// Native radio cards preserve keyboard selection. App owns the chosen workflow;
// this component reports it only when Continue is pressed.
const WORKFLOWS = [
  {
    value: "declutter",
    title: "Declutter",
    iconSrc: declutterIcon,
    features: [
      "Get AI suggestions to Keep, Sell, Donate or Discard",
      "Review and adjust every decision",
      "Create editable listing drafts for items you choose to sell",
    ],
    footnote: "Best for quick item decisions",
  },
  {
    value: "reorganise",
    title: "Reorganise",
    iconSrc: reorganiseIcon,
    features: [
      "Let AI identify items for your tidy plan",
      "Choose exactly which items to include",
      "Get a personalised checklist, storage ideas and an optional AI preview",
    ],
    footnote: "Best for space planning",
  },
  {
    value: "both",
    title: "Both",
    iconSrc: bothIcon,
    wideIcon: true,
    recommended: true,
    features: [
      "Get AI suggestions, then review and adjust every decision",
      "Create a tidy plan for kept items, with an optional AI preview",
      "Create editable listing drafts for items you choose to sell",
    ],
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
          Choose a workflow to declutter your space, reorganise it, or do both in one guided pass.
        </p>
      </div>

      <fieldset className="mt-10">
        <legend className="mb-4 w-full text-center text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Choose a workflow
        </legend>

        <div className="grid gap-4 lg:grid-cols-3">
          {WORKFLOWS.map(({ value, title, iconSrc, wideIcon, features, footnote, recommended }) => {
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

                  <ul id={`workflow-${value}-desc`} className="mt-3 flex-1 space-y-1.5 text-left text-sm text-muted-foreground">
                    {features.map((feature) => (
                      <li key={feature} className="flex min-w-0 items-start gap-2">
                        <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-pill bg-primary/70" />
                        <span className="min-w-0 break-words">{feature}</span>
                      </li>
                    ))}
                  </ul>

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
