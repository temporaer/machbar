import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { PageHeader } from "./PageHeader";
import "../styles/index.css";

describe("PageHeader", () => {
  it("toggles all page hints with one accessible info button", async () => {
    renderWithProviders(
      <PageHeader
        title="Heute"
        actions={<button type="button">Aktion</button>}
        hints={[
          { text: "Allgemeiner Hinweis" },
          { label: "Nachhaken", text: ["Erster Hinweis", "Zweiter Hinweis"] },
        ]}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Hinweise zu dieser Seite anzeigen",
    });
    expect(button).toHaveClass("page-header-button", "page-info-button");
    expect(getComputedStyle(button).width).toBe("44px");
    expect(getComputedStyle(button).height).toBe("44px");
    expect(getComputedStyle(button).borderRadius).toBe("50%");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Allgemeiner Hinweis")).not.toBeInTheDocument();
    expect(screen.queryByText("Erster Hinweis")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aktion" })).toBeInTheDocument();

    await userEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Hinweise" })).toBeInTheDocument();
    expect(screen.getByText("Allgemeiner Hinweis")).toBeInTheDocument();
    expect(screen.getByText("Erster Hinweis")).toBeInTheDocument();
    expect(screen.getByText("Zweiter Hinweis")).toBeInTheDocument();

    await userEvent.click(button);
    expect(screen.queryByText("Allgemeiner Hinweis")).not.toBeInTheDocument();
  });
});
