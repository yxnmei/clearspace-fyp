import { ImageUp, Upload } from "lucide-react";
import { buttonVariants } from "./ui/button";
import { cn } from "../lib/cn";

// Stateless, presentational room-photo field shared by the Declutter and
// Reorganise upload forms. It owns NO state and NO validation — the host
// form keeps file state, the object-URL lifecycle, type checking and the
// workflow-specific copy, and passes the results down here.
//
// The native <input type="file"> stays in the DOM, keeps its label
// association (via aria-label so a single name resolves), stays keyboard
// focusable and is disabled with the rest of the form. Only its default
// visual rendering is replaced — a styled trigger plus a filename drawn
// from File.name alone (never a path).
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
      <p className="text-sm font-medium text-foreground">Room photo</p>

      <div
        className={cn(
          "mt-2 flex items-center justify-center overflow-hidden rounded-card border border-border bg-surface-muted",
          disabled && "opacity-60"
        )}
      >
        {previewUrl ? (
          <img src={previewUrl} alt={previewAlt} className="max-h-64 w-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-control bg-accent text-accent-foreground">
              <ImageUp aria-hidden="true" width={22} height={22} />
            </span>
            <p className="text-sm font-medium text-foreground">No photo selected yet</p>
            <p className="text-xs text-muted-foreground">Choose a room photo to get started.</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          id={id}
          type="file"
          accept={accept}
          onChange={onChange}
          disabled={disabled}
          aria-label="Room photo"
          aria-describedby={describedBy}
          className="peer sr-only"
        />
        <label
          htmlFor={id}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "cursor-pointer",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            "peer-disabled:pointer-events-none peer-disabled:opacity-50"
          )}
        >
          <Upload aria-hidden="true" width={16} height={16} />
          {fileName ? "Change photo" : "Choose photo"}
        </label>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {fileName ?? "No photo selected"}
        </span>
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
