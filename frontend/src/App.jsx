import ImageGenStatusBanner from "./components/ImageGenStatusBanner";

// Root shell only — path selection (Declutter/Reorganise/Both), upload
// form, item panel etc. get built as their own components + hooks as
// §3 build order step 6 (frontend) is implemented, following the same
// per-flow-hook pattern as useDeclutterFlow.js.
export default function App() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">ClearSpace</h1>
      <ImageGenStatusBanner />
      <p className="mt-4 text-gray-500">
        Photograph your space, speak your goals, and receive an intelligent action plan.
      </p>
    </div>
  );
}
