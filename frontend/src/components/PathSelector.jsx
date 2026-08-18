// Top-level workflow entry point — presentational, no state of its own.
// App.jsx owns the actual `mode` state; this component only renders the
// three choices and calls onChoose("declutter" | "reorganise" | "both").
//
// Cards, not tabs: tabs imply state-preserving switching between panes,
// which is the WRONG model here — picking a workflow should start it
// fresh every time (see App.jsx's own docstring on why switching away
// fully unmounts the previous workflow). Cards better communicate "make
// a decision, then commit to it".
//
// Both is a real, enabled button as of R6 (BothPage) — mirrors
// Declutter/Reorganise exactly, no disabled/"Coming later" state left.
export default function PathSelector({ onChoose }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <button
        type="button"
        onClick={() => onChoose("declutter")}
        className="rounded-lg border border-stone-200 bg-white p-5 text-left shadow-sm hover:border-green-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <h2 className="mb-1 text-lg font-medium text-stone-900">Declutter</h2>
        <p className="text-sm text-stone-600">
          Get AI-suggested Keep / Sell / Donate / Discard decisions for what's in a room, then review and confirm
          each one yourself.
        </p>
      </button>

      <button
        type="button"
        onClick={() => onChoose("reorganise")}
        className="rounded-lg border border-stone-200 bg-white p-5 text-left shadow-sm hover:border-green-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <h2 className="mb-1 text-lg font-medium text-stone-900">Reorganise</h2>
        <p className="text-sm text-stone-600">
          Choose which detected items to keep in place, then get a structured room plan and an AI-generated visual
          preview.
        </p>
      </button>

      <button
        type="button"
        onClick={() => onChoose("both")}
        className="rounded-lg border border-stone-200 bg-white p-5 text-left shadow-sm hover:border-green-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <h2 className="mb-1 text-lg font-medium text-stone-900">Both</h2>
        <p className="text-sm text-stone-600">
          Declutter first, then reorganise using only the items you chose to keep.
        </p>
      </button>
    </div>
  );
}
