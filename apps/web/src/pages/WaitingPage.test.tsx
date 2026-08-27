import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitingPage } from "./WaitingPage";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeTag, makeTask, makeWaitingGroup } from "../test/fixtures";
import "../styles/index.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getWaiting: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingPage grouping controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("uses the established quiet list-control treatment and exposes every grouping value", async () => {
    mockedApi.getWaiting.mockResolvedValue([]);

    const { container } = renderWithProviders(<WaitingPage />);
    await screen.findByText("Nichts wartet gerade.");

    const grouping = screen.getByRole("group", { name: "Gruppieren nach" });
    expect(grouping.closest(".projects-controls")).not.toBeNull();

    const buttons = within(grouping).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Keine Gruppierung",
      "Kontext",
      "Person",
      "Bereich",
    ]);
    expect(buttons.every((button) => button.classList.contains("list-option-button"))).toBe(true);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("changes the waiting list grouping and keeps selection state accessible", async () => {
    const phone = makeTag({ id: 91, name: "Telefon", kind: "context" });
    mockedApi.getWaiting.mockResolvedValue([
      makeWaitingGroup({
        tasks: [
          makeTask({
            id: 90,
            title: "Rückruf abwarten",
            status: "waiting",
            effectiveTags: [phone],
          }),
          makeTask({ id: 92, title: "Antwort abwarten", status: "waiting" }),
        ],
      }),
    ]);

    renderWithProviders(<WaitingPage />);
    await screen.findByText("Rückruf abwarten");

    const grouping = screen.getByRole("group", { name: "Gruppieren nach" });
    const none = within(grouping).getByRole("button", { name: "Keine Gruppierung" });
    const context = within(grouping).getByRole("button", { name: "Kontext" });

    await userEvent.click(context);
    expect(context).toHaveAttribute("aria-pressed", "true");
    expect(none).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "Telefon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ohne Kontext" })).toBeInTheDocument();

    await userEvent.click(none);
    expect(none).toHaveAttribute("aria-pressed", "true");
    expect(context).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("heading", { name: "Telefon" })).not.toBeInTheDocument();
  });
});
