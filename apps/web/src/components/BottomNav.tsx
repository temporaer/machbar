import { NavLink } from "react-router-dom";
import { useStrings } from "../lib/strings";
import { BottomNavIcon } from "./BottomNavIcon";

export function BottomNav() {
  const strings = useStrings();
  const items = [
    { to: "/today", label: strings.today, icon: "today" },
    { to: "/inbox", label: strings.inbox, icon: "inbox" },
    { to: "/projects", label: strings.projects, icon: "projects" },
    { to: "/waiting", label: strings.waiting, icon: "waiting" },
    { to: "/more", label: strings.more, icon: "more" },
  ] as const;
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
