import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DetailPropertyPill } from "./DetailPropertyPill";

describe("DetailPropertyPill", () => {
  it("renders a set property with the shared base pill class and no add-state modifier", () => {
    render(
      <DetailPropertyPill label="Verantwortlich" onClick={() => {}}>
        Mia
      </DetailPropertyPill>,
    );
    const pill = screen.getByRole("button", { name: /Mia/ });
    expect(pill).toHaveClass("detail-meta-button");
    expect(pill).not.toHaveClass("detail-meta-add-button");
  });

  it("renders an unset property with the same base pill class plus the add-state modifier", () => {
    render(
      <DetailPropertyPill onClick={() => {}} variant="unset">
        + Verantwortlich
      </DetailPropertyPill>,
    );
    const pill = screen.getByRole("button", { name: /Verantwortlich/ });
    expect(pill).toHaveClass("detail-meta-button");
    expect(pill).toHaveClass("detail-meta-add-button");
  });

  it("dispatches onClick and honors disabled without changing geometry classes", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <DetailPropertyPill onClick={onClick}>Wert</DetailPropertyPill>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Wert" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <DetailPropertyPill onClick={onClick} disabled>
        Wert
      </DetailPropertyPill>,
    );
    const disabledPill = screen.getByRole("button", { name: "Wert" });
    expect(disabledPill).toBeDisabled();
    expect(disabledPill).toHaveClass("detail-meta-button");
  });
});
