import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { BottomNav } from "./BottomNav";

describe("BottomNav", () => {
  it("zeigt alle fünf deutschen Navigationspunkte", () => {
    render(
      <MemoryRouter>
        <BottomNav />
      </MemoryRouter>,
    );
    expect(screen.getByText("Heute")).toBeInTheDocument();
    expect(screen.getByText("Eingang")).toBeInTheDocument();
    expect(screen.getByText("Projekte")).toBeInTheDocument();
    expect(screen.getByText("Wartet")).toBeInTheDocument();
    expect(screen.getByText("Mehr")).toBeInTheDocument();
  });

  it("markiert den aktiven Tab", () => {
    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <BottomNav />
      </MemoryRouter>,
    );
    const inboxLink = screen.getByText("Eingang").closest("a");
    expect(inboxLink).toHaveClass("active");
    expect(inboxLink).toHaveAttribute("aria-current", "page");
  });

  it("uses one consistent decorative SVG icon per destination", () => {
    const { container } = render(
      <MemoryRouter>
        <BottomNav />
      </MemoryRouter>,
    );

    const track = container.querySelector(".bottom-nav-inner");
    expect(track).toBeInTheDocument();
    expect(track?.querySelectorAll(".nav-icon svg")).toHaveLength(5);
    expect(track?.querySelectorAll(".nav-icon svg[aria-hidden='true']")).toHaveLength(5);
    expect(container).not.toHaveTextContent("☀️");
    expect(container).not.toHaveTextContent("📥");
    expect(container).not.toHaveTextContent("📁");
    expect(container).not.toHaveTextContent("⏳");
  });
});
