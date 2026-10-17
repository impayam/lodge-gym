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
  profile: svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6"),
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
export const IconWatch = svg("M8 7h8v10H8zM9.5 7l1-4h3l1 4M9.5 17l1 4h3l1-4");
/** A gear with eight teeth (Payam, 2026-10-17: a real gear on Profile and for Settings). */
export const IconSettings = svg(
  "M19.15 10.08L21.42 10.17L21.42 13.83L19.15 13.92L18.41 15.7L19.96 17.37L17.37 19.96L15.7 18.41L13.92 19.15L13.83 21.42L10.17 21.42L10.08 19.15L8.3 18.41L6.63 19.96L4.04 17.37L5.59 15.7L4.85 13.92L2.58 13.83L2.58 10.17L4.85 10.08L5.59 8.3L4.04 6.63L6.63 4.04L8.3 5.59L10.08 4.85L10.17 2.58L13.83 2.58L13.92 4.85L15.7 5.59L17.37 4.04L19.96 6.63L18.41 8.3Z",
  <circle cx="12" cy="12" r="3" />
);


/** Done mark on the set check (mockup 02: 3 px stroke). */
export const IconCheck = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 12l5 5 9-10" />
  </svg>
);

/** Form video (play), filled. */
export const IconPlay = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);

/** More (three dots). */
export const IconMore = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
  </svg>
);

export const IconSearch = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </svg>
);

/** Pick by body part (mockup 05). */
export const IconBody = svg("M12 7v7M7 9l5 2 5-2M9.5 21l2.5-7 2.5 7", <circle cx="12" cy="4.5" r="2" />);

/** Equipment in the exercise rows (mockup 05): barbell (and bodyweight), dumbbell, cable (and machine). */
export const IconBarbell = svg("M3 12h2M19 12h2M6 8v8M18 8v8M9 10v4M15 10v4M9 12h6");
export const IconDumbbell = svg("M4 10v4M20 10v4M7 8v8M17 8v8M7 12h10");
export const IconCable = svg("M12 3v6M8 9h8M10 9l-3 12M14 9l3 12");
