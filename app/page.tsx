import type { Metadata } from "next";
import AppErrorBoundary from "./components/AppErrorBoundary";
import ModelViewer from "./components/ModelViewer";

export const metadata: Metadata = {
  title: "MCT Section Lab",
  description:
    "A local-first MIDAS Civil node cloud viewer with custom coordinates and live slicing.",
};

export default function Home() {
  return (
    <AppErrorBoundary>
      <ModelViewer />
    </AppErrorBoundary>
  );
}
