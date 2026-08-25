import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActionableText } from "./ActionableText";

describe("ActionableText", () => {
  it("turns phone numbers into mobile tel links", () => {
    render(<ActionableText text="Ruf tel: 072194390-387 an" />);

    expect(screen.getByRole("link", { name: "072194390-387" }))
      .toHaveAttribute("href", "tel:072194390-387");
  });

  it("turns email addresses into mailto links", () => {
    render(<ActionableText text="Schreib an schule@example.de." />);

    expect(screen.getByRole("link", { name: "schule@example.de" }))
      .toHaveAttribute("href", "mailto:schule@example.de");
    expect(screen.getByText(/Schreib an/)).toHaveTextContent("Schreib an schule@example.de.");
  });

  it("opens web links safely and adds https to www links", () => {
    render(<ActionableText text="Siehe www.example.de oder https://example.org/x." />);

    expect(screen.getByRole("link", { name: "www.example.de" })).toHaveAttribute(
      "href",
      "https://www.example.de",
    );
    expect(screen.getByRole("link", { name: "https://example.org/x" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("does not mistake ISO dates for phone numbers or interpret HTML", () => {
    const { container } = render(
      <ActionableText text={'Termin 2026-08-25 <img src=x onerror="alert(1)">'} />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
  });
});
