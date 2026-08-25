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
      <MemoryRouter initialEntries={["/eingang"]}>
        <BottomNav />
      </MemoryRouter>,
    );
    const inboxLink = screen.getByText("Eingang").closest("a");
    expect(inboxLink).toHaveClass("active");
  });
});
