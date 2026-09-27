import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalRefBadge } from "./ExternalRefBadge";

describe("ExternalRefBadge", () => {
  it("renders a calendar reference summary and start", () => {
    render(<ExternalRefBadge refs={[{
      summary: "Elternabend",
      start: "2026-10-08T19:00:00+02:00",
    }]} />);
    expect(screen.getByText(/Kalender: Elternabend/)).toBeInTheDocument();
  });
});
