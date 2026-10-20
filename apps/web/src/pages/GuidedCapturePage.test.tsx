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

function swipeCard(target: HTMLElement, deltaX: number, deltaY = 0) {
  fireEvent.pointerDown(target, { clientX: 200, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: 200 + deltaX, clientY: 100 + deltaY, pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: 200 + deltaX, clientY: 100 + deltaY, pointerId: 1 });
}

describe("guided capture", () => {
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
        await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: area.title })).toHaveFocus());
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

  it("follows the finger, swipes left/next and right/back, and preserves the draft", async () => {
    renderJourney("/capture/guided?area=learning");
    const input = screen.getByLabelText(de.guidedCaptureInput);
    await userEvent.type(input, "Noch ein Gedanke");
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    fireEvent.pointerDown(card, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 120, clientY: 102, pointerId: 1 });
    expect(card).toHaveStyle({ transform: "translateX(-80px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    fireEvent.pointerUp(card, { pointerId: 1 });
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.finances.title })).toHaveFocus();
    expect(input).toHaveValue("Noch ein Gedanke");
    swipeCard(card, 64);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toHaveFocus();
    expect(input).toHaveValue("Noch ein Gedanke");
    expect(createTask).not.toHaveBeenCalled();
  });

  it.each([-63, 63, 8, 0])("springs back without navigating for a %ipx gesture", (distance) => {
    renderJourney("/capture/guided?area=learning");
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    swipeCard(card, distance);
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
  });

  it("does not wrap before the first area and follows Next to the finish after the last", () => {
    renderJourney();
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.home.title });
    swipeCard(card, 100);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
    const areas = guidedCaptureCatalog(de).flatMap((group) => group.areas);
    for (const area of areas) {
      expect(screen.getByRole("heading", { name: area.title })).toBeVisible();
      swipeCard(card, -64);
    }
    expect(screen.getByRole("heading", { name: de.guidedCaptureDoneTitle })).toHaveFocus();
    expect(card).not.toBeVisible();
  });

  it("leaves vertical scrolling alone, even if it later drifts horizontally", () => {
    renderJourney("/capture/guided?area=learning");
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    const capture = vi.fn();
    Object.defineProperty(card, "setPointerCapture", { value: capture });
    fireEvent.pointerDown(card, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 190, clientY: 140, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 100, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(card, { pointerId: 1 });
    expect(capture).not.toHaveBeenCalled();
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
  });

  it("ignores gestures starting on the input or buttons, including nested button content", () => {
    renderJourney("/capture/guided?area=learning");
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    const nextButton = screen.getByRole("button", { name: de.guidedCaptureNext });
    for (const target of [
      screen.getByLabelText(de.guidedCaptureInput),
      nextButton,
      nextButton.querySelector("span")!,
    ]) {
      swipeCard(target, -100);
      expect(card).toHaveStyle({ transform: "translateX(0px)" });
      expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    }
  });

  it("cancels a dragged card without navigating", () => {
    renderJourney("/capture/guided?area=learning");
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    fireEvent.pointerDown(card, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(card, { pointerId: 1 });
    fireEvent.pointerUp(card, { pointerId: 1 });
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
  });

  describe("card paging", () => {
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    const animations: {
      target: HTMLElement;
      frames: Keyframe[];
      cancel: ReturnType<typeof vi.fn>;
      finish: () => void;
    }[] = [];
    const animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const cancel = vi.fn();
      animations.push({ target: this, frames, cancel, finish });
      return { finished, cancel };
    });

    beforeEach(() => {
      animations.length = 0;
      Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    });

    afterEach(() => {
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
      vi.unstubAllGlobals();
    });

    it.each(["buttons", "gestures"] as const)("pages outgoing and incoming cards together in both directions with %s", async (navigation) => {
      const { container } = renderJourney("/capture/guided?area=learning");
      const input = screen.getByRole("textbox");
      await userEvent.type(input, "Ein bleibender Gedanke");
      const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
      if (navigation === "buttons") await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
      else swipeCard(card, -80);
      expect(animations).toHaveLength(2);
      const [outgoing, incoming] = animations;
      expect(outgoing!.target).toHaveTextContent(de.guidedCaptureAreas.learning.title);
      expect(outgoing!.target).toHaveAttribute("inert");
      expect(outgoing!.target).toHaveAttribute("aria-hidden", "true");
      expect(outgoing!.target.querySelector("[id]")).toBeNull();
      expect(outgoing!.frames[0]!.transform).toBe(navigation === "gestures" ? "translateX(-80px)" : "translateX(0px)");
      expect(outgoing!.frames[1]!.transform).toBe("translateX(calc(-100% - 24px))");
      expect(incoming!.target).toBe(card);
      expect(incoming!.frames).toEqual([
        { transform: "translateX(calc(100% + 24px))" },
        { transform: "translateX(0px)" },
      ]);
      expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.finances.title })).toHaveFocus();
      expect(screen.getAllByRole("textbox")).toEqual([input]);
      expect(input).toHaveValue("Ein bleibender Gedanke");
      await act(async () => animations.forEach((animation) => animation.finish()));
      expect(container.querySelector(".guided-capture-outgoing")).toBeEmptyDOMElement();

      if (navigation === "buttons") await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
      else swipeCard(card, 80);
      expect(animations[2]!.frames[1]!.transform).toBe("translateX(calc(100% + 24px))");
      expect(animations[3]!.frames[0]!.transform).toBe("translateX(calc(-100% - 24px))");
      expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toHaveFocus();
      expect(input).toHaveValue("Ein bleibender Gedanke");
      expect(createTask).not.toHaveBeenCalled();
    });

    it("uses the same paging for picker jumps, Finish, and Restart", async () => {
      renderJourney();
      await userEvent.click(screen.getByText(de.guidedCaptureBrowse));
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureAreas.celebrations.title }));
      expect(animations[0]!.frames[1]!.transform).toBe("translateX(calc(-100% - 24px))");
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureFinish }));
      expect(animations[2]!.target).toHaveTextContent(de.guidedCaptureAreas.celebrations.title);
      expect(animations[3]!.target).toHaveTextContent(de.guidedCaptureDoneTitle);
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureRestart }));
      expect(animations[4]!.target).toHaveTextContent(de.guidedCaptureDoneTitle);
      expect(animations[5]!.frames[0]!.transform).toBe("translateX(calc(-100% - 24px))");
      expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toHaveFocus();
    });

    it("keeps spring-back for insufficient gestures and switches instantly with reduced motion", async () => {
      const { container } = renderJourney("/capture/guided?area=learning");
      const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
      swipeCard(card, -63);
      expect(animate).not.toHaveBeenCalled();
      expect(card).toHaveStyle({ transform: "translateX(0px)" });
      vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
      swipeCard(card, -80);
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
      expect(animate).not.toHaveBeenCalled();
      expect(container.querySelector(".guided-capture-outgoing")).toBeEmptyDOMElement();
      expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toHaveFocus();
    });

    it("cancels superseded animations without letting their completion remove the new snapshot", async () => {
      const { container, unmount } = renderJourney("/capture/guided?area=learning");
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
      expect(animations[0]!.cancel).toHaveBeenCalledOnce();
      expect(animations[1]!.cancel).toHaveBeenCalledOnce();
      expect(animations[0]!.target).not.toBeInTheDocument();
      await act(async () => animations.slice(0, 2).forEach((animation) => animation.finish()));
      expect(container.querySelector(".guided-capture-outgoing")!.children).toHaveLength(1);
      unmount();
      expect(animations[2]!.cancel).toHaveBeenCalledOnce();
      expect(animations[3]!.cancel).toHaveBeenCalledOnce();
      expect(animations[2]!.target).not.toBeInTheDocument();
    });
  });

  it("retains a failed draft for retry and locks capture/navigation during saving", async () => {
    let rejectSave!: (error: Error) => void;
    createTask.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    renderJourney("/capture/guided?area=learning");
    const input = screen.getByLabelText(de.guidedCaptureInput);
    await userEvent.click(screen.getByText(de.guidedCaptureBrowse));
    await userEvent.type(input, "Etwas im Blick behalten");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    expect(input).toBeDisabled();
    const navigation = screen.getByRole("navigation", { name: de.guidedCapture });
    for (const button of within(navigation).getAllByRole("button")) expect(button).toBeDisabled();
    const exit = screen.getByRole("link", { name: de.guidedCaptureExit });
    expect(exit).toHaveAttribute("aria-disabled", "true");
    expect(exit).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: de.guidedCaptureSave })).toBeDisabled();
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    swipeCard(card, -100);
    swipeCard(card, 100);
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    for (const area of guidedCaptureCatalog(de).flatMap((group) => group.areas)) {
      expect(screen.getByRole("button", { name: area.title })).toBeDisabled();
    }
    await userEvent.click(exit);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    await act(async () => rejectSave(new Error("Save failed")));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("Etwas im Blick behalten");
    expect(input).not.toBeDisabled();
    expect(exit).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByRole("button", { name: de.guidedCaptureBack })).toBeEnabled();
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
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

  it("allows unrelated navigation without cancelling an in-flight create", async () => {
    const persisted: string[] = [];
    let finishSave!: () => void;
    createTask.mockImplementationOnce((input) => new Promise((resolve) => {
      finishSave = () => {
        persisted.push(input.title);
        resolve(makeTask({ title: input.title }));
      };
    }));
    renderJourney();
    await userEvent.type(screen.getByRole("textbox"), "Ein Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    expect(screen.getByRole("textbox")).toBeDisabled();
    await userEvent.click(screen.getByRole("link", { name: "Bottom navigation" }));
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => finishSave());
    expect(persisted).toEqual(["Ein Gedanke"]);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
    expect(screen.queryByRole("list", { name: de.guidedCaptureSavedThoughts })).not.toBeInTheDocument();
  });

  it("re-enables local controls after save completion and stays in the same area", async () => {
    let finishSave!: () => void;
    createTask.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = () => resolve(makeTask({ title: "Ein Gedanke" }));
    }));
    renderJourney("/capture/guided?area=learning");
    await userEvent.type(screen.getByRole("textbox"), "Ein Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeDisabled();
    await act(async () => finishSave());
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByRole("button", { name: de.guidedCaptureBack })).toBeEnabled();
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
    expect(screen.getByRole("link", { name: de.guidedCaptureExit })).toHaveAttribute("aria-disabled", "false");
  });
});
