/**
 * Loading a `.gsim_sch` into the editor, and refusing to destroy one we cannot read.
 *
 * Its own module rather than part of `schematic-main.tsx` so the behaviour below can be
 * tested. That entry point exports nothing and runs on import -- it mounts React, opens the
 * kernel transport and installs global listeners -- so a guard living there is a guard
 * nothing can exercise. Given what the guard is for, that would not do.
 */

import { deserialize } from "../file/deserializer";
import { serialize } from "../file/serializer";
import { postToHost } from "../ipc/vscode-host";
import { useGraphStore } from "../store";

/** Tracks the text last synced with the host so we do not echo host writes back. */
let lastSyncedText: string | null = null;

/**
 * The text of a document we were handed and could not read, and why.
 *
 * Kept because the editor must not write over a file it failed to understand.
 * When a parse fails the store still holds the empty default model, so
 * serialising it and handing that to the host replaces the user's schematic with
 * a blank one -- and the toast they saw, "Nothing to simulate -- the schematic is
 * empty. Add a component first", was advice that would do exactly that (#146).
 *
 * While this is set, `currentDocumentText` returns the original bytes unchanged,
 * so a save is a no-op rather than data loss.
 */
let unreadable: { text: string; reason: string } | null = null;

export function loadDocumentText(text: string): void {
  const parsed = deserialize(text);
  useGraphStore.getState().loadDocument(parsed);
  useGraphStore.getState().clearHistory();
  lastSyncedText = text;
  unreadable = null;
  // The banner lives outside the React tree precisely so a render cannot remove
  // it, which means a successful load has to remove it by hand. Without this,
  // opening a broken document and then a good one left the warning sitting over
  // a perfectly fine schematic -- the guard becoming its own bug. Caught by
  // `clears a previous failure, so one bad file does not freeze the editor`.
  document.getElementById("gsim-unreadable-banner")?.remove();
}

/**
 * Load a document, and if it cannot be read, say so where the user will see it.
 *
 * The failure used to go to `gsim/log`, which the host appends to the kernel's
 * lifecycle channel -- closed by default. So the editor opened on an empty canvas
 * with no indication that a file had been rejected, and the only clue was a toast
 * about the schematic being empty, which described the store accurately and the
 * situation not at all.
 */
export function loadDocumentTextOrReport(text: string): void {
  try {
    loadDocumentText(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    unreadable = { text, reason };
    postToHost({
      type: "gsim/log",
      level: "error",
      message: `failed to parse schematic: ${reason}`,
    });
    postToHost({ type: "gsim/documentUnreadable", reason });
    showUnreadableBanner(reason);
  }
}

/**
 * An in-editor banner, built from plain DOM rather than React.
 *
 * Deliberately not a component in the tree: the tree renders the empty default
 * model, and anything inside it is subject to the same store the failure left
 * untouched. A fixed element appended to `body` cannot be unmounted by a later
 * render, which matters because the whole defect was a message that existed and
 * went nowhere anybody was looking.
 */
export function showUnreadableBanner(reason: string): void {
  const existing = document.getElementById("gsim-unreadable-banner");
  existing?.remove();

  const banner = document.createElement("div");
  banner.id = "gsim-unreadable-banner";
  banner.setAttribute("role", "alert");
  banner.style.cssText = [
    "position:fixed",
    "inset:0 0 auto 0",
    "z-index:2147483647",
    "padding:12px 16px",
    "font:13px var(--vscode-font-family,sans-serif)",
    "background:var(--vscode-inputValidation-errorBackground,#5a1d1d)",
    "color:var(--vscode-foreground,#eee)",
    "border-bottom:1px solid var(--vscode-inputValidation-errorBorder,#be1100)",
  ].join(";");

  const title = document.createElement("strong");
  title.textContent = "This file could not be read, so the canvas below is empty.";
  const detail = document.createElement("div");
  detail.style.cssText = "margin-top:4px;opacity:0.9";
  detail.textContent = reason;
  const safety = document.createElement("div");
  safety.style.cssText = "margin-top:6px";
  safety.textContent =
    "Your file has not been changed, and saving will not overwrite it. Do not add blocks here expecting to repair it.";

  banner.append(title, detail, safety);
  document.body.append(banner);
}

export function currentDocumentText(): string {
  // A document we could not read is handed back byte for byte. Serialising the
  // store here would hand the host an empty model to write over the user's file.
  if (unreadable !== null) {
    return unreadable.text;
  }
  return serialize(useGraphStore.getState().document);
}

/** Test seam: forget any recorded failure. */
export function resetDocumentLoadState(): void {
  lastSyncedText = null;
  unreadable = null;
  document.getElementById("gsim-unreadable-banner")?.remove();
}

/** Test seam: the failure currently recorded, if any. */
export function unreadableDocument(): { text: string; reason: string } | null {
  return unreadable;
}

/** The text last synced with the host, so callers do not echo host writes back. */
export function lastSynced(): string | null {
  return lastSyncedText;
}

/** Record the text just handed to the host. */
export function noteSynced(text: string): void {
  lastSyncedText = text;
}
