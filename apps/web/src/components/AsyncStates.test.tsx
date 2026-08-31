import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { EmptyState, ErrorState } from "./AsyncStates";

describe("EmptyState", () => {
  it("keeps its message accessible and its friendly mark decorative", () => {
    const { container } = render(<EmptyState message="Nichts zu tun" />);

    expect(screen.getByText("Nichts zu tun")).toBeInTheDocument();
    expect(container.querySelector(".empty-state-mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  describe("ErrorState", () => {
    it("does not repeat an identical generic message", () => {
      renderWithProviders(<ErrorState message="Something went wrong." />, {
        locale: "en",
      });

      expect(screen.getAllByText("Something went wrong.")).toHaveLength(1);
      expect(
        screen.getByText("Try again. Your existing work has not been changed."),
      ).toBeInTheDocument();
    });

    it("supports contextual recovery copy and retries", async () => {
      const onRetry = vi.fn();
      renderWithProviders(
        <ErrorState
          title="Could not load Today"
          message="Machbar could not reach the server."
          guidance="Check your connection."
          onRetry={onRetry}
        />,
        { locale: "en" },
      );

      expect(screen.getByRole("alert")).toHaveTextContent("Could not load Today");
      expect(screen.getByRole("alert")).toHaveTextContent("Check your connection.");
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalledOnce();
    });
  });
});
