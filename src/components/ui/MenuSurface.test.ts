import { describe, expect, it } from "vitest";
import { placeMenu } from "./MenuSurface";

describe("placeMenu", () => {
  it("flips at viewport edges and keeps the menu inside the margin", () => {
    expect(placeMenu({ x: 790, y: 590 }, 180, 120, 800, 600)).toEqual({ left: 610, top: 470 });
    expect(placeMenu({ x: 4, y: 4 }, 180, 120, 800, 600)).toEqual({ left: 8, top: 8 });
  });
});
