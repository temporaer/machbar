import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { getCatalog, LocaleProvider, LOCALE_STORAGE_KEY } from "../lib/locale";
import { guidedCaptureCatalog, reflectionDeckStorageKey } from "../lib/guidedCapture";
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
  useIdentity: () => ({ currentMemberId: member.id, members: [{ id: member.id, name: "Mira" }] }),
}));
vi.mock("../lib/refresh", () => ({
  useRefresh: () => ({ bump: vi.fn() }),
}));

const createTask = vi.mocked(api.createTask);
const de = getCatalog("de");
const member = vi.hoisted(() => ({ id: 1 }));

function renderJourney(entry = "/capture/guided", locale: "de" | "en" = "de") {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const tree = () => (
    <LocaleProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Link to="/inbox">Bottom navigation</Link>
        <Link to="/capture/guided?area=travel">Travel area link</Link>
        <Routes>
          <Route path="/capture/guided" element={<GuidedCapturePage />} />
          <Route path="/inbox" element={<h1>Inbox destination</h1>} />
        </Routes>
      </MemoryRouter>
    </LocaleProvider>
  );
  const result = render(tree());
  return { ...result, refresh: () => result.rerender(tree()) };
}

function swipeCard(target: HTMLElement, deltaX: number, deltaY = 0) {
  fireEvent.pointerDown(target, { clientX: 200, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: 200 + deltaX, clientY: 100 + deltaY, pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: 200 + deltaX, clientY: 100 + deltaY, pointerId: 1 });
}

describe("guided capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    member.id = 1;
    vi.spyOn(Math, "random").mockReturnValue(0);
    localStorage.clear();
    sessionStorage.clear();
    let id = 1;
    createTask.mockImplementation(async (input) => makeTask({ id: id++, title: input.title, status: "captured" }));
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["de", "en"] as const)("provides sixteen localized prompt pools in five groups (%s)", async (locale) => {
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
        const prompts = Object.values(area.prompts);
        expect(prompts.length).toBeGreaterThanOrEqual(3);
        expect(new Set(prompts).size).toBe(prompts.length);
        expect(prompts).toContain(screen.getByRole("heading", { level: 2 }).parentElement?.querySelector(".guided-capture-prompt")?.textContent);
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

  it("continues across multiple complete cycles without creating entries or showing an ending", async () => {
    renderJourney();
    const areas = guidedCaptureCatalog(de).flatMap((group) => group.areas);
    for (let cycle = 0; cycle < 3; cycle++) {
      const titles = [];
      for (let index = 0; index < areas.length; index++) {
        titles.push(screen.getByRole("heading", { level: 2 }).textContent);
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
      }
      expect(new Set(titles).size).toBe(16);
    }
    expect(screen.getByRole("textbox")).toBeVisible();
    expect(screen.queryByText(/\d+ \/ 16/)).not.toBeInTheDocument();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("keeps unsaved text while moving between areas, and supports direct revisits", async () => {
    renderJourney("/capture/guided?area=learning");
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    await userEvent.type(screen.getByLabelText(de.guidedCaptureInput), "Noch ein offener Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    await waitFor(() => expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toHaveFocus());
    expect(screen.getByRole("textbox")).toHaveValue("");
    await userEvent.type(screen.getByRole("textbox"), "Ein anderer Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    expect(screen.getByLabelText(de.guidedCaptureInput)).toHaveValue("Noch ein offener Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.getByRole("textbox")).toHaveValue("Ein anderer Gedanke");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("keeps question/history stable on rerenders, Back/Next, picker revisits and repeated direct links", async () => {
    renderJourney("/capture/guided?area=learning");
    const firstQuestion = screen.getByText(de.guidedCaptureAreas.learning.prompts.recall);
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    const forwardQuestion = screen.getByText(de.guidedCaptureAreas.home.prompts.recall).textContent;
    await userEvent.type(screen.getByRole("textbox"), "Ein Entwurf");
    expect(JSON.parse(localStorage.getItem(reflectionDeckStorageKey(1))!).cards).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    expect(screen.getByText(firstQuestion.textContent!)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.getByText(forwardQuestion!)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Ein Entwurf");
    await userEvent.click(screen.getByText(de.guidedCaptureBrowse));
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureAreas.learning.title }));
    expect(screen.getByText(firstQuestion.textContent!)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.getByRole("textbox")).toHaveValue("Ein Entwurf");
    await userEvent.click(screen.getByRole("link", { name: "Travel area link" }));
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.travel.title })).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "Travel area link" }));
    expect(JSON.parse(localStorage.getItem(reflectionDeckStorageKey(1))!).cards).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    expect(screen.getByText(forwardQuestion!)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Ein Entwurf");
  });

  it("restores current and forward cards on reload, but never persists draft or captured text", async () => {
    const journey = renderJourney("/capture/guided?area=learning");
    await userEvent.type(screen.getByRole("textbox"), "Privater gespeicherter Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    const question = screen.getByText(de.guidedCaptureAreas.home.prompts.recall).textContent!;
    await userEvent.type(screen.getByRole("textbox"), "Privater ungespeicherter Gedanke");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    const stored = localStorage.getItem(reflectionDeckStorageKey(1))!;
    expect(stored).not.toContain("Privater");
    journey.unmount();
    renderJourney();
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByRole("list", { name: de.guidedCaptureSavedThoughts })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.getByText(question)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(JSON.parse(localStorage.getItem(reflectionDeckStorageKey(1))!).cards).toHaveLength(2);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("clears ephemeral drafts when the selected member changes without overwriting another member's deck", async () => {
    const journey = renderJourney("/capture/guided?area=learning");
    await userEvent.type(screen.getByRole("textbox"), "Nur für diesen Besuch");
    const firstMemberDeck = localStorage.getItem(reflectionDeckStorageKey(1));
    member.id = 2;
    journey.refresh();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(localStorage.getItem(reflectionDeckStorageKey(1))).toBe(firstMemberDeck);
    expect(localStorage.getItem(reflectionDeckStorageKey(2))).toBeTruthy();
  });

  it("does not move a draft to a new perspective when its area returns in another cycle", async () => {
    renderJourney();
    await userEvent.type(screen.getByRole("textbox"), "Gedanke zur ersten Frage");
    for (let index = 0; index < 16; index++) {
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    }
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
    expect(screen.getByText(de.guidedCaptureAreas.home.prompts.ahead)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    for (let index = 0; index < 16; index++) {
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    }
    expect(screen.getByText(de.guidedCaptureAreas.home.prompts.recall)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Gedanke zur ersten Frage");
  });

  it("only asks before Exit when unsaved drafts would be lost", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderJourney();
    await userEvent.type(screen.getByRole("textbox"), "Noch nicht festgehalten");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(confirm).toHaveBeenCalledWith(de.guidedCaptureDiscardDrafts);
    expect(screen.getByRole("textbox")).toBeVisible();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
  });

  it("protects a pending capture on Exit until its save has succeeded", async () => {
    let finishSave!: () => void;
    createTask.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = () => resolve(makeTask({ title: "Noch unterwegs" }));
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderJourney();
    await userEvent.type(screen.getByRole("textbox"), "Noch unterwegs");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox")).toHaveValue("Noch unterwegs");
    await act(async () => finishSave());
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
    expect(createTask).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toHaveFocus();
    expect(input).toHaveValue("");
    swipeCard(card, 64);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toHaveFocus();
    expect(input).toHaveValue("Noch ein Gedanke");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("supports keyboard Back immediately after swiping to the next card", async () => {
    renderJourney("/capture/guided?area=learning");
    swipeCard(screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title }), -80);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toHaveFocus();
    screen.getByRole("button", { name: de.guidedCaptureBack }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toHaveFocus();
  });

  it.each([-63, 63, 8, 0])("springs back without navigating for a %ipx gesture", (distance) => {
    renderJourney("/capture/guided?area=learning");
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    swipeCard(card, distance);
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
  });

  it("does not wrap before the first card and swipes seamlessly into another cycle", () => {
    renderJourney();
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.home.title });
    swipeCard(card, 100);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
    for (let index = 0; index < 16; index++) {
      swipeCard(card, -64);
    }
    expect(screen.getByRole("heading", { level: 2 })).toHaveFocus();
    expect(card).toBeVisible();
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
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
      expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toHaveFocus();
      expect(screen.getAllByRole("textbox")).toEqual([input]);
      expect(input).toHaveValue("");
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

    it("uses the same paging for picker jumps and stable revisits", async () => {
      renderJourney();
      await userEvent.click(screen.getByText(de.guidedCaptureBrowse));
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureAreas.celebrations.title }));
      expect(animations[0]!.frames[1]!.transform).toBe("translateX(calc(-100% - 24px))");
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
      expect(animations[2]!.target).toHaveTextContent(de.guidedCaptureAreas.celebrations.title);
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureAreas.home.title }));
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

  it("retains a failed draft for retry while navigation stays available during saving", async () => {
    let rejectSave!: (error: Error) => void;
    createTask.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    renderJourney("/capture/guided?area=learning");
    const input = screen.getByLabelText(de.guidedCaptureInput);
    await userEvent.click(screen.getByText(de.guidedCaptureBrowse));
    await userEvent.type(input, "Etwas im Blick behalten");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    expect(input).toBeDisabled();
    const navigation = screen.getByRole("navigation", { name: de.guidedCapture });
    expect(within(navigation).getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
    const exit = screen.getByRole("link", { name: de.guidedCaptureExit });
    expect(exit).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: de.guidedCaptureSave })).toBeDisabled();
    const card = screen.getByRole("region", { name: de.guidedCaptureAreas.learning.title });
    swipeCard(card, -100);
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toBeVisible();
    swipeCard(card, 100);
    expect(card).toHaveStyle({ transform: "translateX(0px)" });
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    for (const area of guidedCaptureCatalog(de).flatMap((group) => group.areas)) {
      expect(screen.getByRole("button", { name: area.title })).toBeEnabled();
    }
    await act(async () => rejectSave(new Error("Save failed")));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("Etwas im Blick behalten");
    expect(input).not.toBeDisabled();
    expect(exit).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(de.guidedCaptureSaved("Etwas im Blick behalten"));
  });

  it.each(["resolve", "reject"] as const)("a save that %ss after navigation belongs only to its original card", async (outcome) => {
    let settle!: () => void;
    createTask.mockImplementationOnce((input) => new Promise((resolve, reject) => {
      settle = () => outcome === "resolve"
        ? resolve(makeTask({ title: input.title, status: "captured" }))
        : reject(new Error("Save failed"));
    }));
    renderJourney("/capture/guided?area=learning");
    await userEvent.type(screen.getByRole("textbox"), "Zur ursprünglichen Frage");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    await act(async () => settle());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: de.guidedCaptureSavedThoughts })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.home.title })).toHaveFocus();
    await userEvent.type(screen.getByRole("textbox"), "Ein neuer Entwurf");
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureBack }));
    if (outcome === "resolve") {
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(screen.getByRole("list", { name: de.guidedCaptureSavedThoughts })).toHaveTextContent("Zur ursprünglichen Frage");
    } else {
      expect(screen.getByRole("textbox")).toHaveValue("Zur ursprünglichen Frage");
      expect(screen.getByRole("alert")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureSave }));
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
      expect(createTask).toHaveBeenCalledTimes(2);
    }
    await userEvent.click(screen.getByRole("button", { name: de.guidedCaptureNext }));
    expect(screen.getByRole("textbox")).toHaveValue("Ein neuer Entwurf");
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

  it("treats the obsolete finish link as an ordinary deck entry", async () => {
    writeTodayScope("work");
    renderJourney("/capture/guided?area=done");
    expect(screen.getByRole("textbox")).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: de.guidedCaptureExit }));
    expect(readTodayScope()).toBe("all");
    expect(screen.getByRole("heading", { name: "Inbox destination" })).toBeVisible();
  });

  it("does not show a position or completion limit when linking to an area", () => {
    renderJourney("/capture/guided?area=celebrations");
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.celebrations.title })).toBeVisible();
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
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
    await act(async () => finishSave());
    expect(screen.getByRole("heading", { name: de.guidedCaptureAreas.learning.title })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByRole("button", { name: de.guidedCaptureBack })).toBeDisabled();
    expect(screen.getByRole("button", { name: de.guidedCaptureNext })).toBeEnabled();
    expect(screen.getByRole("link", { name: de.guidedCaptureExit })).not.toHaveAttribute("aria-disabled");
  });
});
