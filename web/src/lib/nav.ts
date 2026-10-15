// Navigation model (SPEC-v8 §5): five tabs, screens pushed on top of a tab, and where Back goes. Pure, unit-tested.

export type ViewName =
  | "home"
  | "history"
  | "library"
  | "reports"
  | "me"
  | "program"
  | "settings"
  | "ai"
  | "backup"
  | "session"
  | "watch"
  | "photos"
  | "newprogram"
  | "plan"
  | "report"
  | "saved"
  | "coach";

/** The five tabs, each named after its root screen. */
export type TabName = "home" | "history" | "library" | "reports" | "me";

export const TABS: readonly { name: TabName; label: string }[] = [
  { name: "home", label: "Train" },
  { name: "history", label: "History" },
  { name: "library", label: "Library" },
  { name: "reports", label: "Reports" },
  { name: "me", label: "Me" },
];

/** The tab bar indicator's position (0–4). */
export function tabIndex(tab: TabName): number {
  return TABS.findIndex((t) => t.name === tab);
}

export function isTabRoot(view: ViewName): view is TabName {
  return TABS.some((t) => t.name === view);
}

/** The tab after opening `view`: a tab's root screen selects it; a pushed screen stays on the current tab. */
export function tabAfter(view: ViewName, current: TabName): TabName {
  return isTabRoot(view) ? view : current;
}

/**
 * Where Back (the button or the edge swipe) goes from `view` opened on `tab`; null for tab roots and the active
 * session (full screen, with its own Back).
 */
export function backTarget(view: ViewName, tab: TabName): ViewName | null {
  switch (view) {
    case "program":
    case "settings":
    case "ai":
    case "backup":
    case "photos":
      return "me";
    case "watch":
    case "newprogram":
      return "settings";
    case "saved":
      return "history";
    case "report":
    case "plan":
    case "coach":
      return tab;
    default:
      return null;
  }
}

/** The tab bar is hidden on the full-screen views: the active session and the Coach. */
export function showsTabBar(view: ViewName): boolean {
  return view !== "session" && view !== "coach";
}

/** The floating Coach button sits on the five tab screens only. */
export function showsCoachButton(view: ViewName): boolean {
  return isTabRoot(view);
}

/** Edge-swipe back starts within this many CSS pixels of the left edge. */
export const EDGE_ZONE = 20;

/**
 * Whether an edge swipe completes (Back) or springs back: past 35% of the width, or a fast flick to the right
 * (at least 0.5 px/ms after moving 24 px).
 */
export function edgeSwipeOutcome(dx: number, width: number, velocity: number): "back" | "cancel" {
  if (dx >= width * 0.35) return "back";
  return velocity >= 0.5 && dx >= 24 ? "back" : "cancel";
}
