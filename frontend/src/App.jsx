import DeclutterPage from "./components/DeclutterPage";

// Root shell only — path selection (Declutter/Reorganise/Both) will grow
// here once Reorganise/Both exist; for now Declutter is the only real
// workflow, so it's rendered directly. ImageGenStatusBanner/
// useImageGenHealth are deliberately NOT rendered here — image
// generation is a Reorganise concern, unrelated to Declutter, and
// /image-gen/health is still unimplemented; both are kept, unused, for
// that future task rather than deleted.
export default function App() {
  return (
    <div className="min-h-screen bg-stone-50">
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="mb-2 text-2xl font-semibold text-stone-900">ClearSpace</h1>
        <p className="mb-6 text-stone-600">
          Photograph a room to get AI-suggested Keep / Sell / Donate / Discard decisions for what's in it, then
          review and confirm each one yourself before anything is finalised.
        </p>
        <DeclutterPage />
      </div>
    </div>
  );
}
