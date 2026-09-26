import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { itemNumberLabel } from "../utils/format";
import { MAX_CORRECTED_LABEL_LENGTH, validateCorrectedLabel } from "../lib/reorganiseLabelCorrections";
import { cn } from "../lib/cn";

// Plain buttons avoid the primitive's no-wrap class in the selector workspace.
const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 sm:min-h-8";
const PRIMARY_BUTTON = `${BUTTON_BASE} bg-primary text-primary-foreground shadow-card hover:bg-primary-hover`;
const OUTLINE_BUTTON = `${BUTTON_BASE} border border-input bg-surface text-foreground hover:bg-accent hover:text-accent-foreground`;
const GHOST_BUTTON = `${BUTTON_BASE} text-foreground hover:bg-accent hover:text-accent-foreground`;

// Sits outside the checkbox label, so correction cannot toggle selection.
// Saving targets item_id and affects only the next generated plan.
export default function ReorganiseLabelCorrection({
  item,
  onCorrectLabel,
  onClearCorrection,
  disabled = false,
  planExists = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const toggleRef = useRef(null);
  const inputRef = useRef(null);
  const restoreFocusRef = useRef(false);

  const number = itemNumberLabel(item.item_id);
  const isCorrected = item.label_source === "user";
  const inputId = `reorganise-correct-label-${item.item_id}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const toggleText = isCorrected ? "Edit corrected label" : "Wrong label? Correct it";

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      toggleRef.current?.focus();
    }
  }, [isOpen]);

  // Close when plan generation disables correction.
  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  function open() {
    setValue(item.effective_label);
    setError(null);
    setIsOpen(true);
  }

  function close() {
    restoreFocusRef.current = true;
    setIsOpen(false);
    setError(null);
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (disabled) return;
    const validated = validateCorrectedLabel(value);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    if (validated.value !== item.effective_label) {
      onCorrectLabel(item.item_id, validated.value);
      setAnnouncement(
        validated.value === item.clean_label
          ? `Item ${number} is back to its detected label, ${item.clean_label}.`
          : `Item ${number} is now labelled ${validated.value}.`
      );
    }
    close();
  }

  function handleUseDetected() {
    if (disabled) return;
    onClearCorrection(item.item_id);
    setAnnouncement(`Item ${number} is back to its detected label, ${item.clean_label}.`);
    close();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  return (
    <div className="border-t border-border/70 px-3 pb-2 pt-1">
      {announcement && (
        <p role="status" className="sr-only">
          {announcement}
        </p>
      )}

      {!isOpen ? (
        <button
          ref={toggleRef}
          type="button"
          onClick={open}
          disabled={disabled}
          aria-label={`${toggleText} for item ${number}, ${item.effective_label}`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-control text-xs font-medium text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:no-underline disabled:opacity-50 sm:min-h-8"
        >
          <Pencil aria-hidden="true" width={12} height={12} />
          {toggleText}
        </button>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-2 py-1">
          <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
            Corrected label for item {number}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={value}
            maxLength={MAX_CORRECTED_LABEL_LENGTH}
            autoComplete="off"
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            className={cn(
              "block min-h-11 w-full rounded-control border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-9 sm:max-w-sm",
              error ? "border-error" : "border-input"
            )}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            Detected as {item.clean_label}.
            {planExists && " Saving a new label clears your current tidy plan, so you will need to create it again."}
          </p>
          {error && (
            <p id={errorId} role="alert" className="text-xs font-medium text-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={disabled} className={PRIMARY_BUTTON}>
              Save label
            </button>
            {isCorrected && (
              <button type="button" onClick={handleUseDetected} disabled={disabled} className={OUTLINE_BUTTON}>
                Use detected label
              </button>
            )}
            <button type="button" onClick={close} className={GHOST_BUTTON}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
