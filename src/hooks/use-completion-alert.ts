// Tells the student a run is done while they are looking at something else
// (3 October 2026): a solve takes minutes, sometimes twenty, and nobody
// watches a spinner that long. The tab's title counts the solvers as they
// finish - "(2/3) CivilSolve" - and says "✓ Done" if everything finished
// while the page was in the background. Opted in, the browser shows a
// notification too.
//
// Notifications are a desktop feature here: iOS Safari has none outside an
// installed web app, and Android Chrome only shows them through a service
// worker, which this app does not have - so the toggle is hidden where the
// browser has no Notification at all, and a browser that refuses to make one
// is remembered as unsupported. Everything is best effort.

import { useCallback, useEffect, useRef, useState } from "react";

const NOTIFY_KEY = "civilsolve:notify";

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function loadNotify() {
  try {
    return (
      notificationsSupported() &&
      Notification.permission === "granted" &&
      window.localStorage.getItem(NOTIFY_KEY) === "on"
    );
  } catch {
    return false;
  }
}

function saveNotify(on: boolean) {
  try {
    window.localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  } catch {
    // Only the preference is lost.
  }
}

export function useCompletionAlert({
  running,
  finished,
  total,
  summary,
}: {
  /** Whether any task of the run is still going. */
  running: boolean;
  /** Solvers finished (with an answer or not), and solvers in the run. */
  finished: number;
  total: number;
  /** What the notification says, read when the run ends. */
  summary: () => string;
}) {
  const baseTitle = useRef(typeof document === "undefined" ? "CivilSolve" : document.title);
  const wasRunning = useRef(false);
  const [notify, setNotifyState] = useState(loadNotify);
  const [supported, setSupported] = useState(notificationsSupported);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;

  useEffect(() => {
    const base = baseTitle.current;
    if (running) {
      document.title = total ? `(${finished}/${total}) ${base}` : base;
    } else if (wasRunning.current && document.visibilityState === "hidden") {
      document.title = `✓ Done · ${base}`;
      if (notify && notificationsSupported() && Notification.permission === "granted") {
        try {
          const note = new Notification("CivilSolve", { body: summaryRef.current(), tag: "civilsolve-done" });
          note.onclick = () => {
            window.focus();
            note.close();
          };
        } catch {
          // Android Chrome: notifications only through a service worker.
          setSupported(false);
        }
      }
      try {
        navigator.vibrate?.(200);
      } catch {
        // No vibration motor, or not allowed.
      }
    } else {
      document.title = base;
    }
    wasRunning.current = running;
  }, [running, finished, total, notify]);

  // Back on the page: the "✓ Done" has been seen.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !wasRunning.current) {
        document.title = baseTitle.current;
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /** Turns the notification on (asking the browser's permission) or off. */
  const setNotify = useCallback(async (on: boolean) => {
    if (!on) {
      setNotifyState(false);
      saveNotify(false);
      return;
    }
    if (!notificationsSupported()) return;
    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    const granted = permission === "granted";
    setNotifyState(granted);
    saveNotify(granted);
  }, []);

  return {
    notify,
    setNotify,
    /** Whether to offer the toggle: the browser has notifications and has not refused them. */
    notifyAvailable: supported && notificationsSupported() && Notification.permission !== "denied",
  };
}
