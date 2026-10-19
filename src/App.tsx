import { lazy, Suspense } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import CivilAnswerAppPage from "./pages/civil-answer-app";

// The owner's usage page (/admin/usage): its own chunk, loaded on that path only.
const UsagePage = lazy(() => import("./pages/usage-page"));
const isUsagePage = window.location.pathname.replace(/\/+$/, "") === "/admin/usage";

export default function App() {
  return (
    <ThemeProvider>
      {isUsagePage ? (
        <Suspense fallback={null}>
          <UsagePage />
        </Suspense>
      ) : (
        <CivilAnswerAppPage />
      )}
    </ThemeProvider>
  );
}
