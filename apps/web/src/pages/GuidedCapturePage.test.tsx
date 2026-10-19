import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { getCatalog, LocaleProvider, LOCALE_STORAGE_KEY } from "../lib/locale";
import { guidedCaptureCatalog } from "../lib/guidedCapture";
import { makeTask } from "../test/fixtures";
import { GuidedCapturePage } from "./GuidedCapturePage";

vi.mock("../lib/api", () => ({
  api: { createTask: vi.fn() },
}));
vi.mock("../lib/useAsync", () => ({
  useAsync: () => ({ data: [] }),
}));
vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMemberId: 1, members: [{ id: 1, name: "Mira" }] }),
}));
vi.mock("../lib/refresh", () => ({
  useRefresh: () => ({ bump: vi.fn() }),
}));

const createTask = vi.mocked(api.createTask);
const de = getCatalog("de");

function renderJourney(entry = "/capture/guided", locale: "de" | "en" = "de") {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  return render(
    <LocaleProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/capture/guided" element={<GuidedCapturePage />} />
          <Route path="/inbox" element={<h1>Inbox destination</h1>} />
        </Routes>
      </MemoryRouter>
    </LocaleProvider>,
  );
}

describe("guided capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    createTask.mockImplementation(async (input) => makeTask({ title: input.title, status: "captured" }));
  });

  it.each(["de", "en"] as const)("provides sixteen localized, ordered prompts in five groups (%s)", async (locale) => {
    const strings = getCatalog(locale);
    const groups = guidedCaptureCatalog(strings);
    const areas = groups.flatMap((group) => group.areas);
    expect(groups.map((group) => group.areas.length)).toEqual([4, 3, 4, 3, 2]);
    expect(new Set(areas.map((area) => area.id)).size).toBe(16);
    renderJourney("/capture/guided", locale);
    await userEvent.click(screen.getByText(strings.guidedCaptureBrowse));
    for (const group of groups) {
      expect(screen.getByRole("heading", { name: group.title })).toBeInTheDocument();
      for (const area of group.areas) {
        expect(area.icon).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: area.title }));
        expect(screen.getByRole("heading", { level: 2, name: area.title })).toBeInTheDocument();
        expect(screen.getByText(area.prompt)).toBeVisible();
      }
    }
    expect(createTask).not.toHaveBeenCalled();
  });

  it("captures multiple literal thoughts in the same area, without assigning or planning them", async () => {
    renderJourney();
    expect(screen.queryByRole("group", { name: de.captureModifiers })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: de.guidedCaptureSave })).toBeDisabled();
    for (const title of ["Morgen über Zuhause nachdenken", "Mehr Raum für Ideen"]) {
      await userEvent.type(screen.getByLabelText(de.guidedCaptureInput), title);
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
      await waitFor(() => expect(screen.getByLabelText(de.guidedCaptureInput)).toHaveValue(""));
      expect(createTask).toHaveBeenLastCalledWith({
        title, status: "captured", createdByMemberId: 1, ownerMemberId: null, ownerInheritanceMode: "none",
      });
      expect(screen.getByRole("heading", { level: 2, name: de.guidedCaptureAreas.home.title })).toBeInTheDocument();
    }
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("2 Gedanken festgehalten");
    expect(screen.getByLabelText(de.guidedCaptureInput)).toHaveFocus();
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeInTheDocument();
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  it("skips every area without creating entries and offers a gentle finish", async () => {
    renderJourney();
    const areas = guidedCaptureCatalog(de).flatMap((group) => group.areas);
    for (const [index, area] of areas.entries()) {
      expect(screen.getByRole("heading", { level: 2, name: area.title })).toBeVisible();
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", String(index + 1));
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSkip }));
    }
    expect(screen.getByRole("heading", { name: de.guidedCaptureDoneTitle })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(createTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureRestart }));
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
  });

  it("keeps unsaved text while moving between areas, and supports direct revisits", async () => {
    renderJourney("/capture/guided?area=learning");
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    await userEvent.type(screen.getByLabelText(de.guidedCaptureInput), "Noch ein offener Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    await waitFor(() => expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.finances.title })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    expect(screen.getByLabelText(de.guidedCaptureInput)).toHaveValue("Noch ein offener Gedanke");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("retains a failed draft for retry and locks capture/navigation during saving", async () => {
    let rejectSave!: (error: Error) => void;
    createTask.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    renderJourney();
    const input = screen.getByLabelText(de.guidedCaptureInput);
    await userEvent.type(input, "Etwas im Blick behalten");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    expect(input).toBeDisabled();
    const navigation = screen.getByRole("navigation", { name: de.guidedCapture });
    for (const button of within(navigation).getAllByRole("button")) expect(button).toBeDisabled();
    await act(async () => rejectSave(new Error("Save failed")));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("Etwas im Blick behalten");
    expect(input).not.toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Ein Gedanke festgehalten");
  });

  it("falls back to the first area for an unknown link", () => {
    renderJourney("/capture/guided?area=unknown");
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
    expect(screen.getByRole("button", { name: de.guidedCaptureBack })).toBeDisabled();
  });
});
