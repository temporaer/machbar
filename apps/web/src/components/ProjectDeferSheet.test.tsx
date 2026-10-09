import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { householdCalendarDateTimeToRevisitAt } from "@machbar/shared";
import { ProjectDeferSheet } from "./ProjectDeferSheet";
import { makeProject } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";

describe("ProjectDeferSheet", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["2026-03-28T01:30:00.000Z", "2026-03-29", "Diese lokale Uhrzeit"],
    ["2026-10-24T00:30:00.000Z", "2026-10-25", "Diese lokale Uhrzeit"],
  ])(
    "does not clear a revisit when the destination local time is invalid (%s)",
    async (existing, destination, message) => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderWithProviders(
        <ProjectDeferSheet
          story={makeProject({
            id: 50,
            revisitAt: existing,
          })}
          onClose={vi.fn()}
          onSave={onSave}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Datum …" }));
      const dateInput = screen.getByPlaceholderText(
        "z. B. morgen, Freitag, KW 36, 2w",
      );
      fireEvent.change(dateInput, { target: { value: destination } });
      fireEvent.blur(dateInput);
      fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it("preserves the local clock for a valid destination and only clears explicitly", async () => {
    const existing = householdCalendarDateTimeToRevisitAt(
      "2026-03-28",
      "02:30",
      "Europe/Berlin",
    )!;
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderWithProviders(
      <ProjectDeferSheet
        story={makeProject({ id: 51, revisitAt: existing })}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Datum …" }));
    const dateInput = screen.getByPlaceholderText(
      "z. B. morgen, Freitag, KW 36, 2w",
    );
    fireEvent.change(dateInput, { target: { value: "2026-03-30" } });
    fireEvent.blur(dateInput);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        revisitAt: householdCalendarDateTimeToRevisitAt(
          "2026-03-30",
          "02:30",
          "Europe/Berlin",
        ),
      }),
    );

    vi.clearAllMocks();
    fireEvent.click(screen.getByRole("button", { name: "Ohne Wiedervorlage" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ revisitAt: null }),
    );
  });

  it("does not submit a blank custom date", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectDeferSheet
        story={makeProject({ id: 52, revisitAt: "2026-09-05T16:00:00.000Z" })}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Datum …" }));
    const dateInput = screen.getByPlaceholderText(
      "z. B. morgen, Freitag, KW 36, 2w",
    );
    fireEvent.change(dateInput, { target: { value: "" } });
    fireEvent.blur(dateInput);

    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bitte ein Wiedervorlagedatum auswählen.",
    );
    expect(onSave).not.toHaveBeenCalled();
  });
});
