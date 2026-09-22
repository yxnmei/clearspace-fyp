import { ImageUp, Upload } from "lucide-react";
import { buttonVariants } from "./ui/button";
import { cn } from "../lib/cn";

// Stateless, presentational space-photo field shared by the Declutter and
// Reorganise upload forms. It owns NO state and NO validation, the host
// form keeps file state, the object-URL lifecycle, type checking and the
// workflow-specific copy, and passes the results down here.
//
// The native <input type="file"> stays in the DOM, keeps its label
// association (via aria-label so a single name resolves), stays keyboard
// focusable and is disabled with the rest of the form. Only its default
// visual rendering is replaced, a styled trigger plus a filename drawn
// from File.name alone (never a path). There is no drag-and-drop: the
// surface is a calm placeholder, not a drop zone, and says nothing that
// implies one.
//
// Two visual states: an empty, dashed, muted surface that asks for a
// photo, and, once one is chosen, a taller framed preview that becomes
// the emphasised element of the field, with a "Replace photo" trigger
// beneath it.
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

      {/* Trigger first, filename beside it from sm; stacked on phones so a
          long filename never pushes the trigger off screen. The trigger
          is a full-width 44px target on phones and a natural-width small
          button from sm. */}
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
