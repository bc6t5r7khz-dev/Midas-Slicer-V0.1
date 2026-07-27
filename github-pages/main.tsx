import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import AppErrorBoundary from "../app/components/AppErrorBoundary";
import ModelViewer from "../app/components/ModelViewer";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <ModelViewer />
    </AppErrorBoundary>
  </StrictMode>,
);
