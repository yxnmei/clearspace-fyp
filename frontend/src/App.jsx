import { useState } from "react";
import PathSelector from "./components/PathSelector";
import DeclutterPage from "./components/DeclutterPage";
import ReorganisePage from "./components/ReorganisePage";

// Root shell — owns ONLY the top-level workflow choice ("choose" |
// "declutter" | "reorganise"), nothing else. Both remains unimplemented
// (R6) — PathSelector renders it as a genuinely disabled, non-functional
// card, so `mode` can never become "both" here at all.
//
// Switching workflows (or returning to path selection) fully UNMOUNTS
// whichever page was showing, rather than hiding it — DeclutterPage's
// useDeclutterFlow state and ReorganisePage's useReorganiseFlow/
// useImageGenHealth/useObjectUrl state all live inside those component
// subtrees, so unmounting them is what guarantees no stale state leaks
// between workflows, with zero extra reset logic needed here. This is
// also exactly why PathSelector is cards, not tabs — tabs imply
// state-preserving switching, which is the wrong model for this app.
export default function App() {
  const [mode, setMode] = useState("choose"); // "choose" | "declutter" | "reorganise"

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Widened from max-w-3xl: the analysed-room panel + item list need
          room to sit side by side on desktop (DeclutterReview §3). */}
      <div className="mx-auto max-w-5xl p-6">
        <h1 className="mb-2 text-2xl font-semibold text-stone-900">ClearSpace</h1>

        {mode === "choose" && (
          <>
            <p className="mb-6 text-stone-600">
              Photograph a room to declutter it, reorganise it, or both. Choose a workflow to get started.
            </p>
            <PathSelector onChoose={setMode} />
          </>
        )}

        {mode === "declutter" && (
          <>
            <p className="mb-6 text-stone-600">
              Get AI-suggested Keep / Sell / Donate / Discard decisions for what's in a room, then review and
              confirm each one yourself before anything is finalised.
            </p>
            <button
              type="button"
              onClick={() => setMode("choose")}
              className="mb-4 text-sm text-stone-600 underline hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700"
            >
              ← Back to workflow selection
            </button>
            <DeclutterPage />
          </>
        )}

        {mode === "reorganise" && <ReorganisePage onBackToPathSelection={() => setMode("choose")} />}
      </div>
    </div>
  );
}
