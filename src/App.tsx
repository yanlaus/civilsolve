import { ThemeProvider } from "@/components/theme-provider";
import CivilAnswerAppPage from "./pages/civil-answer-app";

export default function App() {
  return (
    <ThemeProvider>
      <CivilAnswerAppPage />
    </ThemeProvider>
  );
}
