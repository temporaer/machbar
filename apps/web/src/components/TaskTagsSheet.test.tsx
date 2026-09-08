import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeTag, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskTagsSheet } from "./TaskTagsSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskTagsSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.updateTask.mockResolvedValue(makeTask() as never);
  });

  it("keeps excluded inherited tags visible so they can be restored", async () => {
    const inherited = makeTag({ id: 11, name: "Zuhause" });
    const task = makeTask({
      id: 42,
      title: "Werkzeug holen",
      inheritedTags: [inherited],
      effectiveTags: [],
      explicitTags: [],
      excludedTagIds: [11],
    });

    renderWithProviders(<TaskTagsSheet task={task} onClose={vi.fn()} />);

    const inheritedField = await screen.findByText("Geerbt");
    const field = inheritedField.closest(".field") as HTMLElement;
    expect(within(field).getByText("Zuhause")).toBeInTheDocument();
    await userEvent.click(
      within(field).getByRole("button", { name: "Ausschluss aufheben" }),
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
        excludedTagIds: [],
        expectedRevision: 1,
      }),
    );
  });

  it("hides inherited tags from the explicit picker while keeping explicit tags editable", async () => {
    const inherited = makeTag({ id: 11, name: "Garten" });
    const explicit = makeTag({ id: 12, name: "Einkauf" });
    mockedApi.getTags.mockResolvedValue([inherited, explicit]);
    const task = makeTask({
      id: 43,
      title: "Beet pflegen",
      inheritedTags: [inherited],
      effectiveTags: [inherited, explicit],
      explicitTags: [explicit],
      excludedTagIds: [],
    });

    renderWithProviders(<TaskTagsSheet task={task} onClose={vi.fn()} />);

    const inheritedField = await screen.findByText("Geerbt");
    expect(inheritedField.closest(".field")).toHaveTextContent("Garten");
    expect(screen.getAllByText("Einkauf")).not.toHaveLength(0);
    expect(screen.getAllByText("Garten")).toHaveLength(1);
  });
});
