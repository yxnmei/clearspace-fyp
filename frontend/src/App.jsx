import { useState } from "react";
import AppShell from "./components/AppShell";
import PathSelector from "./components/PathSelector";
import DeclutterPage from "./components/DeclutterPage";
import ReorganisePage from "./components/ReorganisePage";
import BothPage from "./components/BothPage";

// Switching workflows unmounts the prior page so hook state cannot leak
// between workflows. This root owns only the top-level choice.
const WORKFLOW_NAMES = {
  declutter: "Declutter",
  reorganise: "Reorganise",
  both: "Both",
};

export default function App() {
  const [mode, setMode] = useState("choose");

  const backToChoose = mode === "choose" ? undefined : () => setMode("choose");
  const workflowName = WORKFLOW_NAMES[mode];

  return (
    <AppShell onBack={backToChoose} workflowName={workflowName}>
      {mode === "choose" && <PathSelector onChoose={setMode} />}

      {mode === "declutter" && <DeclutterPage />}

      {mode === "reorganise" && <ReorganisePage />}

      {mode === "both" && <BothPage />}
    </AppShell>
  );
}
