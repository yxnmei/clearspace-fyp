import { useState } from "react";
import AppShell from "./components/AppShell";
import PathSelector from "./components/PathSelector";
import DeclutterPage from "./components/DeclutterPage";
import ReorganisePage from "./components/ReorganisePage";
import BothPage from "./components/BothPage";

// Root shell — owns ONLY the top-level workflow choice ("choose" |
// "declutter" | "reorganise" | "both"), nothing else. Both is real as of
// R6 (BothPage) — PathSelector renders it as a genuine, enabled card,
// exactly like Declutter/Reorganise.
//
// Switching workflows (or returning to path selection) fully UNMOUNTS
// whichever page was showing, rather than hiding it — DeclutterPage's
// useDeclutterFlow state, ReorganisePage's useReorganiseFlow/
// useImageGenHealth/useObjectUrl state, and BothPage's useBothFlow/
// useImageGenHealth/useObjectUrl state all live inside those component
// subtrees, so unmounting them is what guarantees no stale state leaks
// between workflows, with zero extra reset logic needed here. This is
// also exactly why PathSelector is cards, not tabs — tabs imply
// state-preserving switching, which is the wrong model for this app.
//
// The single "Back to workflows" action is provided by AppShell and shown
// on every workflow page (i.e. whenever mode !== "choose"). There is
// deliberately no universal progress indicator: the three workflows have
// different state machines.
export default function App() {
  const [mode, setMode] = useState("choose"); // "choose" | "declutter" | "reorganise" | "both"

  const backToChoose = mode === "choose" ? undefined : () => setMode("choose");

  return (
    <AppShell onBack={backToChoose}>
      {mode === "choose" && <PathSelector onChoose={setMode} />}

      {mode === "declutter" && (
        <>
          <p className="mb-6 max-w-2xl text-muted-foreground">
            Get AI-suggested Keep / Sell / Donate / Discard decisions for what's in a room, then review and
            confirm each one yourself before anything is finalised.
          </p>
          <DeclutterPage />
        </>
      )}

      {mode === "reorganise" && <ReorganisePage />}

      {mode === "both" && <BothPage />}
    </AppShell>
  );
}
