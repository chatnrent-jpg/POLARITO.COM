/**
 * Remembers the ticker across the 5-second page reload (tab-scoped sessionStorage).
 * Holds only the ticker text, never prices, credentials or tier. Fail-soft: if
 * storage is blocked the dashboard simply starts empty after a reload.
 */

const DRAFT_KEY = "polarito.refresh.draft";
const ANALYZED_KEY = "polarito.refresh.analyzed";

function read(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    /* storage blocked: nothing to remember */
  }
}

const draftListeners = new Set<() => void>();

/** What the user has typed in the ticker box (even if not yet analyzed). */
export const readDraft = () => read(DRAFT_KEY);
export const getServerDraft = () => "";
export function saveDraft(v: string): void {
  write(DRAFT_KEY, v);
  draftListeners.forEach((l) => l());
}
export function subscribeDraft(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

/** The ticker last sent to Analyze; reloaded automatically after each refresh. */
export const readAnalyzed = () => read(ANALYZED_KEY);
export const saveAnalyzed = (v: string) => write(ANALYZED_KEY, v);
