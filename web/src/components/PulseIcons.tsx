// Icons of the Pulse design (design/pulse/mockups): 24-unit, 2 px stroke, colour from the text (currentColor).

const svg = (d: string, extra?: preact.JSX.Element) => ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
    {extra}
  </svg>
);

export const TabIcon = {
  home: svg("M3 12h2M19 12h2M6 8v8M18 8v8M9 10v4M15 10v4M9 12h6"),
  history: svg("M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"),
  library: svg("M5 4h4v16H5zM10 4h4v16h-4zM15 5l4 1-3 14-4-1"),
  reports: svg("M5 20V12M10 20V6M15 20v-9M20 20V9M3 20h18"),
  me: svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6"),
};

export const IconCoach = svg("M4 5h16v11H9l-5 4z", <path d="M8 10h8M8 13h5" />);
export const IconBack = svg("M15 5l-7 7 7 7");
export const IconChevron = svg("M9 5l7 7-7 7");
export const IconPlus = svg("M12 5v14M5 12h14");
export const IconSend = svg("M12 19V5M5 12l7-7 7 7");
export const IconCamera = svg("M4 8h3l2-3h6l2 3h3v11H4z", <circle cx="12" cy="13" r="3.5" />);
export const IconProgram = svg("M4 6h16M4 12h16M4 18h10");
export const IconPlanner = svg("M4 6h16v14H4zM4 10h16M9 14h6");
export const IconSpark = svg("M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z");
export const IconDownload = svg("M12 4v11M7 10l5 5 5-5M5 20h14");
export const IconSettings = svg("M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3");
