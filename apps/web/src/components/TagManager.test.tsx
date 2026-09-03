import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeTag } from "../test/fixtures";
import { TagManager } from "./TagManager";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn().mockResolvedValue([]),
    getTags: vi.fn(),
    createTag: vi.fn(),
    deleteTag: vi.fn(),
    updateTag: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TagManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a tag with the selected type and reloads the catalogue", async () => {
    const sport = makeTag({ id: 20, name: "Sport", kind: "area" });
    mockedApi.getTags.mockResolvedValueOnce([]).mockResolvedValueOnce([sport]);
    mockedApi.createTag.mockResolvedValue(sport);
    renderWithProviders(<TagManager />);

    await userEvent.type(await screen.findByLabelText("Tag-Name"), "Sport");
    const kindGroup = screen.getByRole("group", { name: "Typ des neuen Tags" });
    await userEvent.click(within(kindGroup).getByRole("button", { name: "Bereich" }));
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(mockedApi.createTag).toHaveBeenCalledWith("Sport", "area"));
    expect(await screen.findByText("Sport")).toBeInTheDocument();
  });

  it("filters tags by a diacritic-insensitive name search", async () => {
    mockedApi.getTags.mockResolvedValue([
      makeTag({ id: 21, name: "Café", kind: "plain" }),
      makeTag({ id: 22, name: "Garten", kind: "area" }),
    ]);
    renderWithProviders(<TagManager />);

    await screen.findByText("Café");
    await userEvent.type(screen.getByLabelText("Tags durchsuchen"), "cafe");

    expect(screen.getByText("Café")).toBeInTheDocument();
    expect(screen.queryByText("Garten")).not.toBeInTheDocument();
  });

  it("edits name, type, and grouping preference in one focused sheet", async () => {
    const installer = makeTag({
      id: 23,
      name: "Installateur",
      kind: "actor",
      groupingMode: "hidden",
    });
    mockedApi.getTags.mockResolvedValue([installer]);
    mockedApi.updateTag.mockResolvedValue({
      ...installer,
      name: "Handwerker",
      kind: "area",
      groupingMode: "pinned",
      sortPosition: 0,
    });
    renderWithProviders(<TagManager />);

    const article = (await screen.findByText("Installateur")).closest("article")!;
    await userEvent.click(within(article).getByRole("button", { name: "Bearbeiten" }));

    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByLabelText("Tag-Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Handwerker");
    await userEvent.click(
      within(within(dialog).getByRole("group", { name: "Tag-Typ bearbeiten" }))
        .getByRole("button", { name: "Bereich" }),
    );
    await userEvent.click(
      within(within(dialog).getByRole("group", { name: "Gruppierung" }))
        .getByRole("button", { name: "Beim Gruppieren bevorzugen" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTag).toHaveBeenCalledWith(23, {
        name: "Handwerker",
        kind: "area",
        groupingMode: "pinned",
        sortPosition: 0,
      }),
    );
  });

  it("keeps the editor open and surfaces save errors", async () => {
    const garden = makeTag({ id: 24, name: "Garten", kind: "area" });
    mockedApi.getTags.mockResolvedValue([garden]);
    mockedApi.updateTag.mockRejectedValue(new Error("Der Tag „Haus“ existiert bereits."));
    renderWithProviders(<TagManager />);

    const article = (await screen.findByText("Garten")).closest("article")!;
    await userEvent.click(within(article).getByRole("button", { name: "Bearbeiten" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByLabelText("Tag-Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Haus");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Der Tag „Haus“ existiert bereits.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("requires an explicit in-sheet confirmation before deleting", async () => {
    const garden = makeTag({ id: 25, name: "Garten", kind: "area" });
    mockedApi.getTags.mockResolvedValueOnce([garden]).mockResolvedValueOnce([]);
    mockedApi.deleteTag.mockResolvedValue(undefined);
    renderWithProviders(<TagManager />);

    const article = (await screen.findByText("Garten")).closest("article")!;
    await userEvent.click(within(article).getByRole("button", { name: "Bearbeiten" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Tag löschen" }));

    expect(mockedApi.deleteTag).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Tag „Garten“ löschen?")).toBeInTheDocument();
    expect(within(dialog).getByText(/aus allen Projekten und Aufgaben entfernt/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Tag löschen" }));
    await waitFor(() => expect(mockedApi.deleteTag).toHaveBeenCalledWith(25));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("moves preferred tags with clearly labelled priority controls", async () => {
    const garden = makeTag({
      id: 26,
      name: "Garten",
      kind: "area",
      groupingMode: "pinned",
      sortPosition: 0,
    });
    const house = makeTag({
      id: 27,
      name: "Haus",
      kind: "area",
      groupingMode: "pinned",
      sortPosition: 1,
    });
    mockedApi.getTags.mockResolvedValue([garden, house]);
    mockedApi.updateTag.mockResolvedValue(house);
    renderWithProviders(<TagManager />);

    await screen.findByText("Haus");
    await userEvent.click(screen.getByRole("button", { name: "Priorität erhöhen: Haus" }));

    await waitFor(() => {
      expect(mockedApi.updateTag).toHaveBeenNthCalledWith(1, 27, { sortPosition: 0 });
      expect(mockedApi.updateTag).toHaveBeenNthCalledWith(2, 26, { sortPosition: 1 });
    });
  });
});
