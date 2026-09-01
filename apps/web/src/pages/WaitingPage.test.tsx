import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitingPage } from "./WaitingPage";
import { api } from "../lib/api";
import { de as strings } from "../i18n/de";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeTag, makeTask } from "../test/fixtures";
import "../styles/index.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getWaiting: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function localToday(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

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

    const trigger = screen.getByRole("button", { name: /Gruppierung.*Keine/ });
    const controls = trigger.closest(".projects-controls") as HTMLElement;
    expect(controls).not.toBeNull();
    expect(getComputedStyle(controls).marginBottom).toBe("12px");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Gruppieren nach" })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    const grouping = screen.getByRole("group", { name: "Gruppieren nach" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("group", { name: "Gruppieren nach" })).toHaveLength(1);
    expect(grouping).toHaveAttribute("id", trigger.getAttribute("aria-controls"));

    const buttons = within(grouping).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Keine",
      "Kontext",
      "Person",
      "Bereich",
    ]);
    expect(buttons.every((button) => button.classList.contains("list-option-button"))).toBe(true);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the waiting view purpose behind the established page info control", async () => {
    mockedApi.getWaiting.mockResolvedValue([
          makeTask({
            id: 93,
            title: "Freigabe abwarten",
            blocked: true,
            executable: false,
            externalWait: { waitingFor: "Freigabe", revisitDate: null },
          }),
    ]);

    renderWithProviders(<WaitingPage />);
    await screen.findByText("Freigabe abwarten");

    const hint = strings.waitingPageHint;
    const infoButton = screen.getByRole("button", {
      name: "Hinweise zu dieser Seite anzeigen",
    });
    expect(infoButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(hint)).not.toBeInTheDocument();

    await userEvent.click(infoButton);

    expect(infoButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Hinweise" })).toBeInTheDocument();
    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it("changes the waiting list grouping and keeps selection state accessible", async () => {
    const phone = makeTag({ id: 91, name: "Telefon", kind: "context" });
    mockedApi.getWaiting.mockResolvedValue([
          makeTask({
            id: 90,
            title: "Rückruf abwarten",
            blocked: true,
            executable: false,
            externalWait: {
              waitingFor: "Rückruf",
              revisitDate: localToday(),
            },
            effectiveTags: [phone],
            nextBlockerAttentionDate: localToday(),
          }),
          makeTask({
            id: 92,
            title: "Antwort abwarten",
            blocked: true,
            executable: false,
            externalWait: { waitingFor: "Antwort", revisitDate: null },
          }),
    ]);

    renderWithProviders(<WaitingPage />);
    await screen.findByText("Rückruf abwarten");
    expect(screen.getByText("Wiedervorlage: heute")).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: /Gruppierung.*Keine/ });
    await userEvent.click(trigger);
    const grouping = screen.getByRole("group", { name: "Gruppieren nach" });
    const none = within(grouping).getByRole("button", { name: "Keine" });
    const context = within(grouping).getByRole("button", { name: "Kontext" });

    await userEvent.click(context);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Gruppieren nach" })).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName(/Gruppierung.*Kontext/);
    expect(screen.getByRole("heading", { name: "Telefon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ohne Kontext" })).toBeInTheDocument();

    await userEvent.click(trigger);
    const reopenedGrouping = screen.getByRole("group", { name: "Gruppieren nach" });
    expect(within(reopenedGrouping).getByRole("button", { name: "Kontext" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const reopenedNone = within(reopenedGrouping).getByRole("button", { name: "Keine" });
    await userEvent.click(reopenedNone);
    expect(trigger).toHaveAccessibleName(/Gruppierung.*Keine/);
    expect(screen.queryByRole("heading", { name: "Telefon" })).not.toBeInTheDocument();
  });
});
