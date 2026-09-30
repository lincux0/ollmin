import type { ThemeMode } from "../../contracts/ipc";

export function applyThemePreference(
  theme: ThemeMode,
  root: Pick<HTMLElement, "dataset">,
  preference: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">,
): (() => void) | undefined {
  const apply = () => {
    root.dataset.theme = theme === "system" ? (preference.matches ? "dark" : "light") : theme;
  };

  apply();
  if (theme !== "system") return undefined;
  preference.addEventListener("change", apply);
  return () => preference.removeEventListener("change", apply);
}
