import { NavLink } from "react-router-dom";
import { strings } from "../lib/strings";
import { BottomNavIcon } from "./BottomNavIcon";

const items = [
  { to: "/heute", label: strings.today, icon: "today" },
  { to: "/eingang", label: strings.inbox, icon: "inbox" },
  { to: "/projekte", label: strings.projects, icon: "projects" },
  { to: "/wartet", label: strings.waiting, icon: "waiting" },
  { to: "/mehr", label: strings.more, icon: "more" },
] as const;

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label={strings.appName}>
      <div className="bottom-nav-inner">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <span className="nav-icon">
              <BottomNavIcon name={item.icon} />
            </span>
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
