import React from "react";
import ReactDOM from "react-dom/client";
// Manrope, bundled locally (no runtime font fetch). Only the weights the
// interface actually uses (400 body, 500 controls, 600 labels, 700
// headings) and only the Latin subset the English UI needs.
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
