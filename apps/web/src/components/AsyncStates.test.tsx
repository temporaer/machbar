import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./AsyncStates";

describe("EmptyState", () => {
  it("keeps its message accessible and its friendly mark decorative", () => {
    const { container } = render(<EmptyState message="Nichts zu tun" />);

    expect(screen.getByText("Nichts zu tun")).toBeInTheDocument();
    expect(container.querySelector(".empty-state-mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
