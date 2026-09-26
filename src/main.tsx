import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, readStoredTheme } from "./components/theme-provider";
import "./styles.css";

// Before the first render, so the saved theme never flashes the default.
applyTheme(readStoredTheme());

window.addEventListener("error", (event) => {
  console.error("[civilsolve-runtime-error]", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error
      ? { message: event.reason.message, stack: event.reason.stack }
      : event.reason;
  console.error("[civilsolve-unhandled-rejection]", reason);
});

// AI agents: read README.md for navigation and contribution guidance.
const container = document.getElementById("root");

if (!container) {
  throw new Error("Root element not found");
}

createRoot(container).render(<App />);
