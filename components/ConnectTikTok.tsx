"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

const TIKTOK_LOGIN_URL = "https://www.tiktok.com/login";

type Phase =
  | "idle"
  | "loading"
  | "iframe"
  | "iframe-unusable"
  | "popup"
  | "done"
  | "error";

type ConnectTikTokProps = {
  className?: string;
};

const LOCAL_ONLY_NOTICE =
  "TikTok login and session cookies stay on this device only. This app cannot read them and no remote server can save your login from this window. Export Playwright storageState on your computer and use Import session if you need server-side uploads.";

/**
 * Opens TikTok login in-page (iframe) then popup. Does **not** transfer session to the server — browsers block that.
 */
export function ConnectTikTok({ className = "" }: ConnectTikTokProps) {
  const modalTitleId = useId();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoPopupAttempted = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const openCenteredPopup = useCallback(() => {
    const w = 500;
    const h = 700;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    const features = `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`;
    const win = window.open(TIKTOK_LOGIN_URL, "tiktok_oauth_connect", features);
    if (!win || win.closed) {
      setError("Popup was blocked. Allow popups for this site, then tap “Open TikTok login (popup)” again.");
      setPhase("error");
      return null;
    }
    popupRef.current = win;
    setPhase("popup");
    setError(null);
    return win;
  }, []);

  const onPopupClosed = useCallback(() => {
    setPhase("done");
  }, []);

  useEffect(() => {
    if (phase !== "popup" || !popupRef.current) return;

    clearPoll();
    pollRef.current = setInterval(() => {
      const win = popupRef.current;
      if (!win || win.closed) {
        clearPoll();
        popupRef.current = null;
        onPopupClosed();
      }
    }, 500);

    return () => clearPoll();
  }, [phase, onPopupClosed, clearPoll]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      setPhase((p) => (p === "loading" || p === "iframe" ? "iframe-unusable" : p));
    }, 2200);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (phase !== "iframe-unusable" || autoPopupAttempted.current) return;
    autoPopupAttempted.current = true;
    openCenteredPopup();
  }, [phase, openCenteredPopup]);

  const handleOpenModal = () => {
    autoPopupAttempted.current = false;
    setOpen(true);
    setPhase("loading");
    setError(null);
    popupRef.current = null;
  };

  const handleIframeLoad = () => {
    setPhase("iframe");
  };

  const handleUsePopup = () => {
    openCenteredPopup();
  };

  const handleCloseModal = () => {
    setOpen(false);
    setPhase("idle");
    setError(null);
    clearPoll();
    try {
      popupRef.current?.close();
    } catch {
      /* ignore */
    }
    popupRef.current = null;
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCloseModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={handleOpenModal}
        className={
          className ||
          "rounded-xl bg-gradient-to-r from-pink-600 to-rose-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-pink-600/25 transition hover:brightness-110"
        }
      >
        Connect TikTok
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={modalTitleId}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            aria-label="Close overlay"
            onClick={handleCloseModal}
          />
          <div className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-700">
              <h2 id={modalTitleId} className="text-lg font-bold text-zinc-900 dark:text-white">
                Connect TikTok
              </h2>
              <button
                type="button"
                onClick={handleCloseModal}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Close
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-4 overflow-auto p-5">
              <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-relaxed text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
                <strong className="font-semibold">Local machine only.</strong> Your TikTok session is never saved by a
                remote server from this screen. Log in here on <strong>this computer</strong> only; then export
                storageState locally and use <strong>Import session</strong> if automations need a copy.
              </div>

              {(phase === "loading" || phase === "iframe") && (
                <div className="flex flex-col items-center justify-center gap-3 py-6">
                  <div
                    className="h-10 w-10 animate-spin rounded-full border-2 border-pink-500 border-t-transparent"
                    aria-hidden
                  />
                  <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">Loading TikTok…</p>
                </div>
              )}

              {(phase === "loading" || phase === "iframe" || phase === "iframe-unusable" || phase === "error") && (
                <div className="relative min-h-[280px] w-full overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-950">
                  <iframe
                    key={open ? "tiktok-frame" : "off"}
                    title="TikTok login"
                    src={TIKTOK_LOGIN_URL}
                    className="h-[min(320px,45vh)] w-full border-0"
                    onLoad={handleIframeLoad}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                  />
                </div>
              )}

              {phase === "iframe-unusable" && (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                  TikTok usually blocks embedding in iframes. A login window should open — if it didn’t, use the button
                  below (requires popups).
                </div>
              )}

              {(phase === "iframe-unusable" || phase === "error") && (
                <button
                  type="button"
                  onClick={handleUsePopup}
                  className="w-full rounded-xl bg-zinc-900 py-3 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-pink-600 dark:hover:bg-pink-500"
                >
                  Open TikTok login (popup)
                </button>
              )}

              {phase === "popup" && (
                <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
                  Complete login in the popup on <strong>this machine</strong>. When you close it, we’ll confirm — nothing
                  is uploaded to a server from here.
                </p>
              )}

              {phase === "done" && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
                  <p className="font-medium">Login window closed</p>
                  <p className="mt-2 text-emerald-900/90 dark:text-emerald-200/90">{LOCAL_ONLY_NOTICE}</p>
                </div>
              )}

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">
                  {error}
                </p>
              )}

              {phase !== "done" && (
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
                  No session data is sent to your app server from this dialog — only local browser / TikTok.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
