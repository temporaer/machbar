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

  it("creates a tag inline and reloads the catalogue", async () => {
    const sport = makeTag({ id: 20, name: "Sport" });
    mockedApi.getTags.mockResolvedValueOnce([]).mockResolvedValueOnce([sport]);
    mockedApi.createTag.mockResolvedValue(sport);
    renderWithProviders(<TagManager />);

    await screen.findByRole("textbox", { name: "Neuer Tag" });
    await userEvent.type(screen.getByRole("textbox", { name: "Neuer Tag" }), "Sport");
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(mockedApi.createTag).toHaveBeenCalledWith("Sport"));
    expect(await screen.findByText("Sport")).toBeInTheDocument();
  });

  it("deletes a tag after explicit confirmation", async () => {
    const garden = makeTag({ id: 21, name: "Garten" });
    mockedApi.getTags.mockResolvedValueOnce([garden]).mockResolvedValueOnce([]);
    mockedApi.deleteTag.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<TagManager />);

    const chip = (await screen.findByText("Garten")).closest("span")!;
    await userEvent.click(within(chip).getByRole("button", { name: "Entfernen" }));

    expect(window.confirm).toHaveBeenCalledWith(
      "Tag „Garten“ endgültig löschen? Er wird aus allen Projekten und Aufgaben entfernt.",
    );
    await waitFor(() => expect(mockedApi.deleteTag).toHaveBeenCalledWith(21));
    await waitFor(() => expect(screen.queryByText("Garten")).not.toBeInTheDocument());
  });

  it("keeps the tag when deletion is cancelled", async () => {
    const garden = makeTag({ id: 22, name: "Garten" });
    mockedApi.getTags.mockResolvedValue([garden]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<TagManager />);

    const chip = (await screen.findByText("Garten")).closest("span")!;
    await userEvent.click(within(chip).getByRole("button", { name: "Entfernen" }));

    expect(mockedApi.deleteTag).not.toHaveBeenCalled();
    expect(screen.getByText("Garten")).toBeInTheDocument();
  });

  it("updates a tag kind through lightweight chips", async () => {
    const installer = makeTag({
      id: 23,
      name: "Installateur",
      kind: "actor",
    });
    mockedApi.getTags.mockResolvedValue([installer]);
    mockedApi.updateTag.mockResolvedValue({ ...installer, kind: "area" });
    renderWithProviders(<TagManager />);

    const article = (await screen.findByText("Installateur")).closest("article")!;
    await userEvent.click(within(article).getByRole("button", { name: "Bereich" }));

    await waitFor(() =>
      expect(mockedApi.updateTag).toHaveBeenCalledWith(23, { kind: "area" }),
    );
  });
});
