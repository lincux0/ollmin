export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 264;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_COLLAPSE_BREAKPOINT = 1024;

const WIDTH_KEY = "ollmin.ui.sidebar.width";
const COLLAPSED_KEY = "ollmin.ui.sidebar.collapsed";

export type SidebarPreferences = { width: number; collapsed: boolean };
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function clampSidebarWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))
    : SIDEBAR_DEFAULT_WIDTH;
}

export function loadSidebarPreferences(storage?: StorageLike | null): SidebarPreferences {
  const fallback = { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false };
  if (!storage) return fallback;
  try {
    const width = Number(storage.getItem(WIDTH_KEY));
    const collapsed = storage.getItem(COLLAPSED_KEY);
    return {
      width: Number.isFinite(width) && width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH
        ? Math.round(width)
        : fallback.width,
      collapsed: collapsed === "true" ? true : collapsed === "false" ? false : fallback.collapsed,
    };
  } catch {
    return fallback;
  }
}

export function saveSidebarWidth(storage: StorageLike | null | undefined, width: number): void {
  try { storage?.setItem(WIDTH_KEY, String(clampSidebarWidth(width))); } catch { /* UI preference is optional. */ }
}

export function saveSidebarCollapsed(storage: StorageLike | null | undefined, collapsed: boolean): void {
  try { storage?.setItem(COLLAPSED_KEY, String(collapsed)); } catch { /* UI preference is optional. */ }
}

export function isSidebarNarrow(width: number): boolean {
  return width < SIDEBAR_COLLAPSE_BREAKPOINT;
}
