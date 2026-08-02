import type { Metadata } from "next";
import AppErrorBoundary from "./components/AppErrorBoundary";
import ModelViewer from "./components/ModelViewer";
import { APP_NAME, APP_VERSION } from "./lib/appVersion";

export const metadata: Metadata = {
  title: `${APP_NAME} ${APP_VERSION}`,
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
