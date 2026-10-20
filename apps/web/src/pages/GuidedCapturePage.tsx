import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CaptureForm } from "../components/CaptureForm";
import {
  guidedCaptureCatalog, nextReflectionCard, readReflectionDeck,
  visitReflectionArea, writeReflectionDeck,
  type ReflectionDeck,
} from "../lib/guidedCapture";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { readTodayScope, writeTodayScope } from "../lib/todayScope";
import { useHorizontalSwipe } from "../lib/useHorizontalSwipe";

export function GuidedCapturePage() {
  const { currentMemberId } = useIdentity();
  return <GuidedCaptureDeck key={currentMemberId ?? "anonymous"} memberId={currentMemberId} />;
}

function GuidedCaptureDeck({ memberId }: { memberId: number | null }) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [params, setParams] = useSearchParams();
  const groups = guidedCaptureCatalog(strings);
  const areas = groups.flatMap((group) =>
    group.areas.map((area) => ({ ...area, group: group.title })),
  );
  const [deck, setDeck] = useState(() => {
    let restored = readReflectionDeck(memberId, areas);
    const requested = params.get("area");
    if (requested) restored = visitReflectionArea(restored, areas, requested);
    return restored.cards.length ? restored : nextReflectionCard(restored, areas);
  });
  const card = deck.cards[deck.index]!;
  const area = areas.find((item) => item.id === card.areaId)!;
  const prompt = area.prompts[card.promptId as keyof typeof area.prompts];
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingCardId, setSavingCardId] = useState<number | null>(null);
  const [thoughts, setThoughts] = useState<{ id: number; title: string; areaId: string }[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const paging = useRef<{
    snapshot: HTMLElement;
    direction: number;
    animations: Animation[];
  } | null>(null);
  const clearPaging = useCallback(() => {
    const current = paging.current;
    paging.current = null;
    current?.animations.forEach((animation) => animation.cancel());
    current?.snapshot.remove();
  }, []);
  useEffect(() => clearPaging, [clearPaging]);
  useLayoutEffect(() => {
    const current = paging.current;
    const card = cardRef.current;
    if (!current || !card) return;
    const timing = { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
    const left = "translateX(calc(-100% - 24px))";
    const right = "translateX(calc(100% + 24px))";
    current.animations = [
      current.snapshot.animate([
        { transform: current.snapshot.style.transform },
        { transform: current.direction > 0 ? left : right },
      ], timing),
      card.animate([
        { transform: current.direction > 0 ? right : left },
        { transform: "translateX(0px)" },
      ], timing),
    ];
    void Promise.all(current.animations.map((animation) => animation.finished)).then(() => {
      if (paging.current === current) clearPaging();
    }, () => {});
  }, [card.id, clearPaging]);
  const focusAfterNavigation = useRef(false);
  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    headingRef.current?.focus();
  }, [card.id]);

  useEffect(() => {
    writeReflectionDeck(memberId, deck);
  }, [memberId, deck]);

  // Handle external area links, but not the URL updates made by our own paging.
  const requestedArea = params.get("area");
  const handledArea = useRef(requestedArea);
  useEffect(() => {
    if (requestedArea === handledArea.current) return;
    handledArea.current = requestedArea;
    if (requestedArea) setDeck((current) => visitReflectionArea(current, areas, requestedArea));
  }, [requestedArea]);

  const goTo = (target: ReflectionDeck) => {
    if (target.cards[target.index]?.id === card.id) {
      headingRef.current?.focus();
      return;
    }
    const element = cardRef.current;
    const transform = element ? getComputedStyle(element).transform : "none";
    clearPaging();
    if (element && outgoingRef.current && typeof element.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      // A visual-only snapshot keeps the outgoing card intact without mounting
      // a second capture form or duplicating its mutation/focus lifecycle.
      const snapshot = element.cloneNode(true) as HTMLElement;
      snapshot.setAttribute("inert", "");
      snapshot.setAttribute("aria-hidden", "true");
      snapshot.removeAttribute("id");
      snapshot.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      snapshot.classList.remove("guided-capture-swipe");
      snapshot.style.transform = transform;
      outgoingRef.current.append(snapshot);
      paging.current = { snapshot, direction: target.cards[target.index]!.id > card.id ? 1 : -1, animations: [] };
    }
    focusAfterNavigation.current = true;
    setDeck(target);
    const id = target.cards[target.index]!.areaId;
    handledArea.current = id;
    setParams({ area: id }, { replace: true });
  };
  const protectedIds = Object.keys(drafts).map(Number).filter((id) => drafts[id]);
  const next = () => goTo(nextReflectionCard(deck, areas, Math.random, protectedIds));
  const back = () => {
    if (deck.index > 0) goTo({ ...deck, index: deck.index - 1 });
  };
  const swipe = useHorizontalSwipe<HTMLElement>({
    ignoreInteractive: true,
    onPrimary: back,
    onSecondary: next,
    onRealDrag: clearPaging,
  });
  useEffect(() => {
    swipe.cancel();
  }, [card.id, swipe.cancel]);
  const showCapturedInbox = () => {
    if (readTodayScope() === "work") writeTodayScope("all");
  };

  return (
    <div className="guided-capture-page stack">
      <header className="guided-capture-header">
        <h1>{strings.guidedCapture}</h1>
        <Link to="/inbox" className="btn btn-sm"
          onClick={(event) => {
            if (Object.entries(drafts).some(([id, draft]) => Number(id) !== savingCardId && draft.trim()) &&
              !window.confirm(strings.guidedCaptureDiscardDrafts)) event.preventDefault();
            else showCapturedInbox();
          }}>{strings.guidedCaptureExit}</Link>
      </header>

      <div className="guided-capture-deck">
        <section ref={cardRef} className="guided-capture-card guided-capture-swipe" data-tone={area.tone}
          data-dragging={swipe.dragX !== 0} style={{ transform: `translateX(${swipe.dragX}px)` }}
          {...swipe.handlers} aria-labelledby="life-area-title">
          <div key={card.id} className="guided-capture-reflection">
            <div className="guided-capture-card-top">
              <span className="guided-capture-eyebrow">{area.group}</span>
            </div>
            <span className="guided-capture-icon" aria-hidden="true">{area.icon}</span>
            <h2 id="life-area-title" ref={headingRef} tabIndex={-1}
              aria-describedby="life-area-prompt">{area.title}</h2>
            <p id="life-area-prompt" className="guided-capture-prompt">{prompt}</p>
          </div>
          {thoughts.some((thought) => thought.areaId === area.id) ? (
            <ul className="guided-capture-thoughts" aria-label={strings.guidedCaptureSavedThoughts}>
              {thoughts.filter((thought) => thought.areaId === area.id).map((thought) => (
                <li key={thought.id}><span aria-hidden="true">✓</span>{thought.title}</li>
              ))}
            </ul>
          ) : null}
          <CaptureForm
            mode="thought"
            autoFocus={false}
            onSavingChange={(saving) => setSavingCardId(saving ? card.id : null)}
            thoughtDraft={{
              key: card.id,
              title: drafts[card.id] ?? "",
              onChange: (title) => setDrafts((previous) => ({ ...previous, [card.id]: title })),
            }}
            onCaptured={({ task }) => {
              setThoughts((previous) => [...previous, { id: task.id, title: task.title, areaId: area.id }]);
              setAnnouncement(strings.guidedCaptureSaved(task.title));
              setDrafts((previous) => {
                const next = { ...previous };
                delete next[card.id];
                return next;
              });
              bump();
            }}
          />
          <nav className="guided-capture-navigation" aria-label={strings.guidedCapture}>
            <button type="button" className="btn" disabled={deck.index === 0} onClick={back}>
              {strings.guidedCaptureBack}
            </button>
            <button type="button" className="btn guided-capture-next" onClick={next}>
              {strings.guidedCaptureNext}
              <span aria-hidden="true"> →</span>
            </button>
          </nav>
        </section>

        <div ref={outgoingRef} className="guided-capture-outgoing" aria-hidden="true" />
      </div>
      <p className="visually-hidden" role="status">{announcement}</p>
      <p className="guided-capture-inbox-note">{strings.guidedCaptureDestination}</p>

      <details className="guided-capture-catalog">
        <summary>{strings.guidedCaptureBrowse}</summary>
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`life-group-${group.id}`}>
            <h3 id={`life-group-${group.id}`}>{group.title}</h3>
            <div className="guided-capture-area-grid">
              {group.areas.map((item) => (
                <button key={item.id} type="button" className="guided-capture-area"
                  aria-current={item.id === area.id ? "step" : undefined}
                  onClick={() => goTo(visitReflectionArea(deck, areas, item.id, Math.random, protectedIds))}>
                  <span aria-hidden="true">{item.icon}</span>
                  <span>{item.title}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </details>
    </div>
  );
}
