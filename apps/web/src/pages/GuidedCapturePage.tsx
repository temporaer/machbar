import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CaptureForm } from "../components/CaptureForm";
import { guidedCaptureCatalog } from "../lib/guidedCapture";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { readTodayScope, writeTodayScope } from "../lib/todayScope";
import { useHorizontalSwipe } from "../lib/useHorizontalSwipe";

export function GuidedCapturePage() {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [params, setParams] = useSearchParams();
  const groups = guidedCaptureCatalog(strings);
  const areas = groups.flatMap((group) =>
    group.areas.map((area) => ({ ...area, group: group.title })),
  );
  const index = Math.max(0, areas.findIndex((area) => area.id === params.get("area")));
  const area = areas[index]!;
  const done = params.get("area") === "done";
  const [formKey, setFormKey] = useState(0);
  const [saving, setSaving] = useState(false);
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
  }, [area.id, done, clearPaging]);
  const focusAfterNavigation = useRef(false);
  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    headingRef.current?.focus();
  }, [area.id, done]);

  const goTo = (id: string) => {
    if (saving) return;
    if ((!done && id === area.id) || (done && id === "done")) {
      headingRef.current?.focus();
      return;
    }
    const card = cardRef.current;
    const transform = card ? getComputedStyle(card).transform : "none";
    clearPaging();
    if (card && outgoingRef.current && typeof card.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      // A visual-only snapshot keeps the outgoing card intact without mounting
      // a second capture form or duplicating its mutation/focus lifecycle.
      const snapshot = card.cloneNode(true) as HTMLElement;
      snapshot.setAttribute("inert", "");
      snapshot.setAttribute("aria-hidden", "true");
      snapshot.removeAttribute("id");
      snapshot.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      snapshot.classList.remove("guided-capture-swipe");
      snapshot.style.transform = transform;
      outgoingRef.current.append(snapshot);
      const targetIndex = id === "done" ? areas.length : areas.findIndex((item) => item.id === id);
      paging.current = { snapshot, direction: targetIndex > (done ? areas.length : index) ? 1 : -1, animations: [] };
    }
    focusAfterNavigation.current = true;
    setParams({ area: id }, { replace: true });
  };
  const next = () => goTo(areas[index + 1]?.id ?? "done");
  const swipe = useHorizontalSwipe<HTMLElement>({
    disabled: saving || done,
    ignoreInteractive: true,
    onPrimary: () => {
      if (index > 0) goTo(areas[index - 1]!.id);
    },
    onSecondary: next,
    onRealDrag: clearPaging,
  });
  useEffect(() => {
    swipe.cancel();
  }, [area.id, done, swipe.cancel]);
  const showCapturedInbox = () => {
    if (readTodayScope() === "work") writeTodayScope("all");
  };

  return (
    <div className="guided-capture-page stack">
      <header className="guided-capture-header">
        <h1>{strings.guidedCapture}</h1>
        <Link to="/inbox" className="btn btn-sm" aria-disabled={saving} tabIndex={saving ? -1 : undefined}
          onClick={(event) => {
            if (saving) event.preventDefault();
            else showCapturedInbox();
          }}>{strings.guidedCaptureExit}</Link>
      </header>

      <div className="guided-capture-deck">
        <section ref={done ? undefined : cardRef} className="guided-capture-card guided-capture-swipe" data-tone={area.tone}
          data-dragging={swipe.dragX !== 0} style={{ transform: `translateX(${swipe.dragX}px)` }}
          {...swipe.handlers} hidden={done} aria-labelledby="life-area-title">
          <div key={area.id} className="guided-capture-reflection">
            <div className="guided-capture-card-top">
              <span className="guided-capture-eyebrow">{area.group}</span>
              <span className="guided-capture-position">{strings.guidedCapturePosition(index + 1, areas.length)}</span>
            </div>
            <span className="guided-capture-icon" aria-hidden="true">{area.icon}</span>
            <h2 id="life-area-title" ref={done ? undefined : headingRef} tabIndex={-1}
              aria-describedby="life-area-prompt">{area.title}</h2>
            <p id="life-area-prompt" className="guided-capture-prompt">{area.prompt}</p>
          </div>
          {thoughts.some((thought) => thought.areaId === area.id) ? (
            <ul className="guided-capture-thoughts" aria-label={strings.guidedCaptureSavedThoughts}>
              {thoughts.filter((thought) => thought.areaId === area.id).map((thought) => (
                <li key={thought.id}><span aria-hidden="true">✓</span>{thought.title}</li>
              ))}
            </ul>
          ) : null}
          <CaptureForm
            key={formKey}
            mode="thought"
            autoFocus={formKey > 0}
            onSavingChange={setSaving}
            onCaptured={({ task }) => {
              setThoughts((previous) => [...previous, { id: task.id, title: task.title, areaId: area.id }]);
              setAnnouncement(strings.guidedCaptureSaved(task.title));
              setFormKey((key) => key + 1);
              bump();
            }}
          />
          <nav className="guided-capture-navigation" aria-label={strings.guidedCapture}>
            <button type="button" className="btn" disabled={saving || index === 0}
              onClick={() => goTo(areas[index - 1]!.id)}>
              {strings.guidedCaptureBack}
            </button>
            <button type="button" className="btn guided-capture-next" disabled={saving} onClick={next}>
              {index === areas.length - 1 ? strings.guidedCaptureFinish : strings.guidedCaptureNext}
              <span aria-hidden="true"> →</span>
            </button>
          </nav>
        </section>

        {done ? (
          <section ref={cardRef} className="guided-capture-card guided-capture-finish stack">
            <span className="guided-capture-icon" aria-hidden="true">🌤️</span>
            <h2 ref={headingRef} tabIndex={-1}>{strings.guidedCaptureDoneTitle}</h2>
            <Link to="/inbox" className="btn btn-primary" onClick={showCapturedInbox}>{strings.guidedCaptureInbox}</Link>
            <button type="button" className="btn" onClick={() => goTo(areas[0]!.id)}>
              {strings.guidedCaptureRestart}
            </button>
          </section>
        ) : null}
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
                  aria-current={!done && item.id === area.id ? "step" : undefined}
                  disabled={saving} onClick={() => goTo(item.id)}>
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
