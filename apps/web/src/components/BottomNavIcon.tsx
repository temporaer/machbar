import type { ReactNode } from "react";

type BottomNavIconName = "today" | "inbox" | "projects" | "waiting" | "more";

const paths: Record<BottomNavIconName, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 5.5h16v13H4z" />
      <path d="M4 14h4l1.5 2h5L16 14h4M12 3v8M9 8l3 3 3-3" />
    </>
  ),
  projects: (
    <path d="M3.5 6.5h6l2 2h9v10h-17zM3.5 6.5V5h7l1.5 1.5" />
  ),
  waiting: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5l3.2 2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.25" />
      <circle cx="12" cy="12" r="1.25" />
      <circle cx="19" cy="12" r="1.25" />
    </>
  ),
};

export function BottomNavIcon({ name }: { name: BottomNavIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
