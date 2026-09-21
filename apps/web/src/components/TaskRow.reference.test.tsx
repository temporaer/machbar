import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    makeTaskAction: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskRow – reference presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("renders a reference row without a completion checkbox, status controls, or next-action badge", async () => {
    const reference = makeTask({
      id: 1,
      kind: "reference",
      title: "Unterkunft",
      notes: "https://example.com/ Gute Lage",
    });
    renderWithProviders(<TaskOutline tasks={[reference]} emptyMessage="Nichts da" />);

    await screen.findByText("Unterkunft");
    expect(screen.queryByRole("button", { name: "Erledigt" })).not.toBeInTheDocument();
    expect(screen.queryByText("Aktiv")).not.toBeInTheDocument();
  });

  it("renders the reference's primary web link as an openable link and the remaining text separately", async () => {
    const reference = makeTask({
      id: 1,
      kind: "reference",
      title: "Camping Wang",
      notes: "https://camping-wang.ch/\n\nDirekt am See",
    });
    renderWithProviders(<TaskOutline tasks={[reference]} emptyMessage="Nichts da" />);

    const link = await screen.findByRole("link", { name: /camping-wang\.ch/ });
    expect(link).toHaveAttribute("href", "https://camping-wang.ch/");
    expect(await screen.findByText("Direkt am See")).toBeInTheDocument();
  });

  it("offers 'Als Aufgabe behandeln' from the reference's action menu and calls the promotion endpoint", async () => {
    const reference = makeTask({ id: 1, kind: "reference", title: "Unterkunft" });
    mockedApi.makeTaskAction.mockResolvedValue(
      makeTask({ id: 1, kind: "action", title: "Unterkunft" }),
    );
    renderWithProviders(<TaskOutline tasks={[reference]} emptyMessage="Nichts da" />);

    await screen.findByText("Unterkunft");
    await userEvent.click(screen.getByRole("button", { name: /weitere aktionen/i }));
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe behandeln" }));

    expect(mockedApi.makeTaskAction).toHaveBeenCalledWith(1, 1);
  });

  it("still renders drag-handle/expand affordances and children for a reference", async () => {
    const child = makeTask({ id: 2, kind: "action", title: "Hotel buchen" });
    const reference = makeTask({
      id: 1,
      kind: "reference",
      title: "Hotels",
      children: [child],
    });
    renderWithProviders(<TaskOutline tasks={[reference]} emptyMessage="Nichts da" />);

    await screen.findByText("Hotels");
    expect(await screen.findByText("Hotel buchen")).toBeInTheDocument();
  });
});
