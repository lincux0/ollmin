import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  isSidebarNarrow,
  loadSidebarPreferences,
  SIDEBAR_DEFAULT_WIDTH,
} from "./sidebar";

describe("sidebar preferences", () => {
  it("defaults and clamps invalid widths without trusting malformed preferences", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(900)).toBe(420);
    expect(loadSidebarPreferences({ getItem: () => "999", setItem: () => undefined })).toEqual({ width: 280, collapsed: false });
    expect(loadSidebarPreferences({ getItem: (key) => key.endsWith("width") ? "390" : "true", setItem: () => undefined })).toEqual({ width: 390, collapsed: true });
  });

  it("survives storage failures and applies the exact automatic-collapse breakpoint", () => {
    expect(loadSidebarPreferences({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined })).toEqual({ width: 280, collapsed: false });
    expect(isSidebarNarrow(1023)).toBe(true);
    expect(isSidebarNarrow(1024)).toBe(false);
  });
});
