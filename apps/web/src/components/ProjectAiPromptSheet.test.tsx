import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { buildProjectAiPromptText } from "../lib/projectAiPrompt";
import { de as strings } from "../i18n/de";
import { MarkdownNotes } from "./MarkdownNotes";
import { ProjectAiPromptSheet } from "./ProjectAiPromptSheet";

describe("ProjectAiPromptSheet", () => {
  it("copies and shares the same prompt with only checked material", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const share = vi.fn().mockResolvedValue(undefined);
    const selected = makeTask({
      id: 1,
      title: "Quelle A",
      kind: "reference",
      notes: "[Artikel](https://example.test/a)\n\n**Anmerkung A**",
    });
    const unselected = makeTask({
      id: 2,
      title: "Quelle B",
      kind: "reference",
      notes: "Anmerkung B",
    });
    renderWithProviders(
      <ProjectAiPromptSheet
        projectTitle="Recherche"
        materials={[
          { task: selected, parentTitles: [] },
          { task: unselected, parentTitles: ["Kontext"] },
        ]}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: strings.projectAiPromptInstruction }), "Vergleiche die Quellen.");
    await user.click(screen.getByRole("checkbox", { name: "Quelle A" }));
    const expected = buildProjectAiPromptText("Vergleiche die Quellen.", [
      { task: selected, parentTitles: [] },
    ]);
    expect(screen.getByRole("button", { name: strings.reflectionCopy })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: strings.reflectionCopy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));

    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await user.click(screen.getByRole("button", { name: strings.projectAiPromptShare }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({
      title: "KI-Prompt erstellen: Recherche",
      text: expected,
    }));
    expect(expected).toContain("[Artikel](https://example.test/a)");
    expect(expected).toContain("**Anmerkung A**");
    expect(expected).not.toContain(unselected.title);
    expect(expected).not.toContain(unselected.notes);
  });

  it("uses the clipboard with the same payload when native sharing is unavailable", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    renderWithProviders(
      <ProjectAiPromptSheet projectTitle="Recherche" materials={[]} onClose={vi.fn()} />,
    );

    await user.type(screen.getByRole("textbox", { name: strings.projectAiPromptInstruction }), "Ideen sammeln.");
    await user.click(screen.getByRole("button", { name: strings.projectAiPromptShare }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Ideen sammeln."));
  });

  it("keeps each selected note's reference-link target when rendered together", () => {
    const markdown = buildProjectAiPromptText("", [
      {
        task: makeTask({
          id: 1,
          title: "Quelle A",
          kind: "reference",
          notes: "[Link][source]\n\n[source]: https://example.test/a",
        }),
        parentTitles: [],
      },
      {
        task: makeTask({
          id: 2,
          title: "Quelle B",
          kind: "reference",
          notes: "[Link][source]\n\n[source]: https://example.test/b",
        }),
        parentTitles: [],
      },
    ]);

    const { container } = renderWithProviders(<MarkdownNotes value={markdown} />);

    expect(Array.from(container.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual([
      "https://example.test/a",
      "https://example.test/b",
    ]);
  });

  it("asks before discarding an authored prompt", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <ProjectAiPromptSheet projectTitle="Recherche" materials={[]} onClose={onClose} />,
    );

    await user.type(screen.getByRole("textbox", { name: strings.projectAiPromptInstruction }), "Ideen sammeln.");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(strings.projectAiPromptDiscardWarning);

    await user.click(screen.getByRole("button", { name: strings.projectAiPromptKeepEditing }));
    expect(screen.getByRole("textbox", { name: strings.projectAiPromptInstruction })).toHaveValue("Ideen sammeln.");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: strings.discard }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
