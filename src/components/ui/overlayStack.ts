const overlays: HTMLElement[] = [];

export function pushOverlay(element: HTMLElement) {
  overlays.push(element);
  return () => {
    const index = overlays.lastIndexOf(element);
    if (index >= 0) overlays.splice(index, 1);
  };
}

export function topOverlay() {
  return overlays.at(-1) ?? null;
}
