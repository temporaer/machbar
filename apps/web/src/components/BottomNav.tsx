import { NavLink } from "react-router-dom";
import { strings } from "../lib/strings";

const items = [
  { to: "/heute", label: strings.today, icon: "☀️" },
  { to: "/eingang", label: strings.inbox, icon: "📥" },
  { to: "/projekte", label: strings.projects, icon: "📁" },
  { to: "/wartet", label: strings.waiting, icon: "⏳" },
  { to: "/mehr", label: strings.more, icon: "⋯" },
] as const;

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label={strings.appName}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => (isActive ? "active" : "")}
        >
          <span className="nav-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
