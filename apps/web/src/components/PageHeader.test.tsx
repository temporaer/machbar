import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("preserves the heading and supplied actions without generic help", () => {
    render(<PageHeader title="Heute" actions={<button type="button">Aktion</button>} />);
    expect(screen.getByRole("heading", { name: "Heute", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Aktion" })]);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("supports section headings without requiring any providers", () => {
    const { container } = render(<PageHeader title="Aufgaben" headingLevel={2} />);
    expect(screen.getByRole("heading", { name: "Aufgaben", level: 2 })).toBeInTheDocument();
    expect(container.querySelector(".page-header-actions")).toBeNull();
  });
});
