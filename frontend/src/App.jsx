import { useState } from "react";
import AppShell from "./components/AppShell";
import PathSelector from "./components/PathSelector";
import DeclutterPage from "./components/DeclutterPage";
import ReorganisePage from "./components/ReorganisePage";
import BothPage from "./components/BothPage";

// Root shell, owns ONLY the top-level workflow choice ("choose" |
// "declutter" | "reorganise" | "both"), nothing else. Both is real as of
// R6 (BothPage), PathSelector renders it as a genuine, enabled card,
// exactly like Declutter/Reorganise.
//
// Switching workflows (or returning to path selection) fully UNMOUNTS
// whichever page was showing, rather than hiding it, DeclutterPage's
// useDeclutterFlow state, ReorganisePage's useReorganiseFlow/
// useImageGenHealth/useObjectUrl state, and BothPage's useBothFlow/
// useImageGenHealth/useObjectUrl state all live inside those component
// subtrees, so unmounting them is what guarantees no stale state leaks
// between workflows, with zero extra reset logic needed here. This is
// also exactly why PathSelector is cards, not tabs, tabs imply
// state-preserving switching, which is the wrong model for this app.
//
// The single "Back to workflows" action is provided by AppShell and shown
// on every workflow page (i.e. whenever mode !== "choose"). Progress is
// not universal: each workflow page renders its own WorkflowProgress
// stepper from its own hook state, since the three workflows have
// different state machines. The workflow-selection screen shows none.
export default function App() {
  const [mode, setMode] = useState("choose"); // "choose" | "declutter" | "reorganise" | "both"

  const backToChoose = mode === "choose" ? undefined : () => setMode("choose");

  return (
    <AppShell onBack={backToChoose}>
      {mode === "choose" && <PathSelector onChoose={setMode} />}

      {mode === "declutter" && <DeclutterPage />}

      {mode === "reorganise" && <ReorganisePage />}

      {mode === "both" && <BothPage />}
    </AppShell>
  );
}
