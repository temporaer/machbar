import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagPicker } from "./TagPicker";
import { api } from "../lib/api";
import { makeTag } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    createTag: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TagPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("zeigt alle Tags als kompakte, direkt antippbare Auswahl", async () => {
    const onChange = vi.fn();
    render(
      <TagPicker
        tags={[
          makeTag({ id: 1, name: "Lars", color: "#2563eb" }),
          makeTag({ id: 2, name: "Garten", color: "#16a34a" }),
        ]}
        selectedIds={[1]}
        onChange={onChange}
      />,
    );

    const lars = screen.getByRole("button", { name: "Lars" });
    expect(lars).toHaveClass("tag-choice");
    expect(lars).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Garten" }));
    expect(onChange).toHaveBeenCalledWith([1, 2]);
  });

  it("legt einen neuen farbigen Tag an und wählt ihn sofort aus", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    mockedApi.createTag.mockResolvedValue(makeTag({ id: 3, name: "Sport", color: "#dc2626" }));
    render(<TagPicker tags={[]} selectedIds={[]} onChange={onChange} />);

    await userEvent.type(screen.getByRole("textbox", { name: "Neuer Tag: Normal" }), "Sport");
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(mockedApi.createTag).toHaveBeenCalledWith("Sport", "plain"));
    expect(await screen.findByRole("button", { name: "Sport" })).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith([3]);
  });

  it("zeigt Erstellungsfehler an und behält die Eingabe", async () => {
    mockedApi.createTag.mockRejectedValue(new Error("Tag konnte nicht angelegt werden."));
    render(<TagPicker tags={[]} selectedIds={[]} onChange={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "Neuer Tag: Normal" });
    await userEvent.type(input, "Sport");
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Tag konnte nicht angelegt werden.");
    expect(input).toHaveValue("Sport");
  });

  it("übernimmt den gewählten Typ ohne zusätzlichen Klassifizierungsdialog", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    mockedApi.createTag.mockResolvedValue(
      makeTag({ id: 4, name: "Telefon", kind: "context" }),
    );
    render(<TagPicker tags={[]} selectedIds={[]} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Kontext" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Neuer Tag: Kontext" }),
      "Telefon",
    );
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() =>
      expect(mockedApi.createTag).toHaveBeenCalledWith("Telefon", "context"),
    );
  });
});
