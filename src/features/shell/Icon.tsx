export type IconName = "plus" | "search" | "sidebar" | "minimize" | "maximize" | "restore" | "close" | "sparkle" | "send" | "chevron";

const ICON_PATHS: Record<IconName, string> = {
  plus: "M12 5v14M5 12h14",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M16 16l4 4",
  sidebar: "M4 5h16v14H4zM9 5v14",
  minimize: "M5 12h14",
  maximize: "M6 6h12v12H6z",
  restore: "M8 8h11v11H8zM5 16H4V5h11v1",
  close: "M6 6l12 12M18 6 6 18",
  sparkle: "M12 3.5l1.9 5.8L20 11l-6.1 1.7L12 19l-1.9-6.3L4 11l6.1-1.7L12 3.5z",
  send: "M12 19V5m-6 6 6-6 6 6",
  chevron: "m7 10 5 5 5-5",
};

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
