import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CaptureForm } from "../components/CaptureForm";
import { guidedCaptureCatalog } from "../lib/guidedCapture";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { readTodayScope, writeTodayScope } from "../lib/todayScope";

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
  const savingRef = useRef(false);
  const onSavingChange = (pending: boolean) => {
    savingRef.current = pending;
    setSaving(pending);
  };

  useEffect(() => {
    const guardLink = (event: MouseEvent) => {
      if (savingRef.current && event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const guardKeys = (event: KeyboardEvent) => {
      if (!savingRef.current || event.key === "Tab") return;
      event.stopImmediatePropagation();
      if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
    };
    const guardUnload = (event: BeforeUnloadEvent) => {
      if (!savingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardNavigation = (event: Event) => {
      if (savingRef.current && event.cancelable) event.preventDefault();
    };
    // The Navigation API also covers browser back/forward in supporting browsers.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    document.addEventListener("click", guardLink, true);
    window.addEventListener("keydown", guardKeys, true);
    window.addEventListener("beforeunload", guardUnload);
    navigation?.addEventListener("navigate", guardNavigation);
    return () => {
      document.removeEventListener("click", guardLink, true);
      window.removeEventListener("keydown", guardKeys, true);
      window.removeEventListener("beforeunload", guardUnload);
      navigation?.removeEventListener("navigate", guardNavigation);
    };
  }, []);

  const goTo = (id: string) => {
    if (savingRef.current) return;
    setParams({ area: id }, { replace: true });
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  const next = () => goTo(areas[index + 1]?.id ?? "done");
  const showCapturedInbox = () => {
    if (readTodayScope() === "work") writeTodayScope("all");
  };

  return (
    <div className="guided-capture-page stack">
      <header className="guided-capture-header">
        <h1>{strings.guidedCapture}</h1>
        <Link to="/inbox" className="btn btn-sm" aria-disabled={saving} tabIndex={saving ? -1 : undefined}
          onClick={(event) => {
            if (savingRef.current) event.preventDefault();
            else showCapturedInbox();
          }}>{strings.guidedCaptureExit}</Link>
      </header>

      <section className="guided-capture-card" data-tone={area.tone} hidden={done} aria-labelledby="life-area-title">
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
          onSavingChange={onSavingChange}
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

      <p className="visually-hidden" role="status">{announcement}</p>

      {done ? (
        <section className="guided-capture-card guided-capture-finish stack">
          <span className="guided-capture-icon" aria-hidden="true">🌤️</span>
          <h2 ref={headingRef} tabIndex={-1}>{strings.guidedCaptureDoneTitle}</h2>
          <Link to="/inbox" className="btn btn-primary" onClick={showCapturedInbox}>{strings.guidedCaptureInbox}</Link>
          <button type="button" className="btn" onClick={() => goTo(areas[0]!.id)}>
            {strings.guidedCaptureRestart}
          </button>
        </section>
      ) : null}
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
