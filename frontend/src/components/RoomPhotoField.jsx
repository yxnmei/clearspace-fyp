import { ImageUp, Upload } from "lucide-react";
import { buttonVariants } from "./ui/button";
import { cn } from "../lib/cn";

// Stateless shared photo field. The native labelled input remains focusable;
// hosts own validation, file state and object URLs.
export default function RoomPhotoField({
  id,
  accept,
  disabled = false,
  onChange,
  fileName = null,
  previewUrl = null,
  previewAlt,
  helpText,
  error = null,
}) {
  const helpId = helpText ? `${id}-help` : null;
  const errorId = error ? `${id}-error` : null;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <p className="text-sm font-medium text-foreground">Space photo</p>

      {previewUrl ? (
        <div
          className={cn(
            "mt-2 overflow-hidden rounded-card border-2 border-primary/30 bg-surface-muted shadow-card",
            disabled && "opacity-60"
          )}
        >
          <img src={previewUrl} alt={previewAlt} className="max-h-80 w-full object-contain" />
        </div>
      ) : (
        <div
          className={cn(
            "mt-2 flex items-center justify-center rounded-card border border-dashed border-border bg-surface-muted",
            disabled && "opacity-60"
          )}
        >
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-control bg-accent text-accent-foreground">
              <ImageUp aria-hidden="true" width={22} height={22} />
            </span>
            <p className="text-sm font-medium text-foreground">No photo selected yet</p>
            <p className="text-xs text-muted-foreground">Choose a photo of your space to get started.</p>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          id={id}
          type="file"
          accept={accept}
          onChange={onChange}
          disabled={disabled}
          aria-label="Space photo"
          aria-describedby={describedBy}
          className="peer sr-only"
        />
        <label
          htmlFor={id}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "min-h-11 w-full cursor-pointer sm:min-h-0 sm:w-auto",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            "peer-disabled:pointer-events-none peer-disabled:opacity-50"
          )}
        >
          <Upload aria-hidden="true" width={16} height={16} />
          {fileName ? "Replace photo" : "Choose photo"}
        </label>
        {fileName ? (
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={fileName}>
            {fileName}
          </span>
        ) : null}
      </div>

      {helpText ? (
        <p id={helpId} className="mt-2 text-xs text-muted-foreground">
          {helpText}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-xs font-medium text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
