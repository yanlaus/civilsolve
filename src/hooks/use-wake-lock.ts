// Keeps the screen awake while `active` is true, so a phone left on the desk
// during a long solve does not lock itself: locking backgrounds the tab, and
// iOS then cuts the tab's connections ("Load failed"). Best effort - where
// the API is missing or the request is refused, the resume-on-return path in
// lib/sse.ts (withResume) still recovers the solve.

import { useEffect } from "react";

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || sentinel || document.visibilityState !== "visible") return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener("release", () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Refused (battery saver, no user gesture) or unsupported: nothing to do.
      }
    };

    // The browser drops the lock whenever the page is hidden; take it again
    // when the user comes back while work is still running.
    const onVisibilityChange = () => {
      void acquire();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void acquire();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
