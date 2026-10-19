import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { getCatalog, LocaleProvider, LOCALE_STORAGE_KEY } from "../lib/locale";
import { guidedCaptureCatalog } from "../lib/guidedCapture";
import { readTodayScope, writeTodayScope } from "../lib/todayScope";
import { makeTask } from "../test/fixtures";
import { GuidedCapturePage } from "./GuidedCapturePage";
import { CaptureForm } from "../components/CaptureForm";

vi.mock("../lib/api", () => ({
  api: {
    createTask: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
    getProjects: vi.fn().mockResolvedValue([]),
    getHomeAssistantStatus: vi.fn().mockResolvedValue(null),
  },
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
        <Link to="/inbox">Bottom navigation</Link>
        <Routes>
          <Route path="/capture/guided" element={<GuidedCapturePage />} />
          <Route path="/inbox" element={<h1>Inbox destination</h1>} />
        </Routes>
      </MemoryRouter>
    </LocaleProvider>,
  );
}

describe("guided capture", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    let id = 1;
    createTask.mockImplementation(async (input) => makeTask({ id: id++, title: input.title, status: "captured" }));
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
    expect(screen.queryByRole("button", { name: de.cancel })).not.toBeInTheDocument();
    expect(screen.queryByText(`${de.captureDestination}: ${de.inbox}`)).not.toBeInTheDocument();
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
    const saved = screen.getByRole("list", { name: de.guidedCaptureSavedThoughts });
    expect(within(saved).getAllByRole("listitem")).toHaveLength(2);
    expect(saved).toHaveTextContent("Morgen über Zuhause nachdenken");
    expect(saved).toHaveTextContent("Mehr Raum für Ideen");
    expect(screen.getByRole("status")).toHaveTextContent(de.guidedCaptureSaved("Mehr Raum für Ideen"));
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
      expect(screen.getByText(de.guidedCapturePosition(index + 1, areas.length))).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", {
        name: index === areas.length - 1 ? de.guidedCaptureFinish : de.guidedCaptureNext,
      }));
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
    const exit = screen.getByRole("link", { name: de.guidedCaptureExit });
    expect(exit).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(exit);
    await userEvent.click(screen.getByRole("link", { name: "Bottom navigation" }));
    expect(screen.getByRole("heading", { name: de.guidedCapture })).toBeVisible();
    const globalShortcut = vi.fn();
    window.addEventListener("keydown", globalShortcut);
    fireEvent.keyDown(window, { key: "g" });
    expect(globalShortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", globalShortcut);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => rejectSave(new Error("Save failed")));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("Etwas im Blick behalten");
    expect(input).not.toBeDisabled();
    expect(exit).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(de.guidedCaptureSaved("Etwas im Blick behalten"));
  });

  it("falls back to the first area for an unknown link", () => {
    renderJourney("/capture/guided?area=unknown");
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
    expect(screen.getByRole("button", { name: de.guidedCaptureBack })).toBeDisabled();
  });

  it.each(["mine", "all", "work"] as const)("returns to a visible household inbox from %s scope", async (scope) => {
    writeTodayScope(scope);
    renderJourney();
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(readTodayScope()).toBe(scope === "work" ? "all" : scope);
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
  });

  it("also reveals household captures when returning from the finish screen", async () => {
    writeTodayScope("work");
    renderJourney("/capture/guided?area=done");
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureInbox }));
    expect(readTodayScope()).toBe("all");
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
  });

  it("shows position, not completion, when jumping straight to the last area", () => {
    renderJourney("/capture/guided?area=celebrations");
    expect(screen.getByText(de.guidedCapturePosition(16, 16))).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: de.guidedCapture }).querySelectorAll("button")).toHaveLength(2);
  });

  it("keeps saved thoughts with their area when browsing and returning", async () => {
    renderJourney();
    await userEvent.type(screen.getByLabelText(de.guidedCaptureInput), "Ein offener Wunsch");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    expect(await screen.findByRole("list", { name: de.guidedCaptureSavedThoughts })).toHaveTextContent("Ein offener Wunsch");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.queryByRole("list", { name: de.guidedCaptureSavedThoughts })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    expect(screen.getByRole("list", { name: de.guidedCaptureSavedThoughts })).toHaveTextContent("Ein offener Wunsch");
  });

  it("does not request capture metadata in thought mode, including after a save", async () => {
    renderJourney();
    await userEvent.type(screen.getByLabelText(de.guidedCaptureInput), "Morgen @Mira #Idee");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await waitFor(() => expect(screen.getByLabelText(de.guidedCaptureInput)).toHaveValue(""));
    expect(api.getTags).not.toHaveBeenCalled();
    expect(api.getProjects).not.toHaveBeenCalled();
    expect(api.getHomeAssistantStatus).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Morgen @Mira #Idee" }));
  });

  it("still requests metadata for standard capture", async () => {
    render(<CaptureForm onCancel={vi.fn()} onCaptured={vi.fn()} />);
    await waitFor(() => expect(api.getTags).toHaveBeenCalled());
    expect(api.getProjects).toHaveBeenCalled();
    expect(api.getHomeAssistantStatus).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: de.cancel })).toBeVisible();
  });

  it("blocks native history navigation while saving and releases the guard afterwards", async () => {
    const navigation = new EventTarget();
    vi.stubGlobal("navigation", navigation);
    let finishSave!: () => void;
    createTask.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = () => resolve(makeTask({ title: "Ein Gedanke" }));
    }));
    renderJourney();
    await userEvent.type(screen.getByRole("textbox"), "Ein Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    const blocked = new Event("navigate", { cancelable: true });
    navigation.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    await act(async () => finishSave());
    const allowed = new Event("navigate", { cancelable: true });
    navigation.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
    await userEvent.click(screen.getByRole("link", { name: "Bottom navigation" }));
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
  });
});
