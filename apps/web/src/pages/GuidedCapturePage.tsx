import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CaptureForm } from "../components/CaptureForm";
import { guidedCaptureCatalog } from "../lib/guidedCapture";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";

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
  const [saved, setSaved] = useState<{ title: string; count: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const goTo = (id: string) => {
    setParams({ area: id }, { replace: true });
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  const next = () => goTo(areas[index + 1]?.id ?? "done");

  return (
    <div className="guided-capture-page stack">
      <header className="guided-capture-header">
        <span className="guided-capture-eyebrow">{strings.guidedCapture}</span>
        <Link to="/inbox" className="btn btn-sm">{strings.guidedCaptureExit}</Link>
      </header>
      <div className="guided-capture-intro">
        <h1>{strings.guidedCaptureTitle}</h1>
        <p>{strings.guidedCaptureIntro}</p>
      </div>

      <section className="guided-capture-card stack" hidden={done} aria-labelledby="life-area-title">
        <div className="guided-capture-progress">
          <span>{strings.guidedCaptureProgress(index + 1, areas.length)}</span>
          <progress
            value={index + 1}
            max={areas.length}
            aria-label={strings.guidedCaptureProgress(index + 1, areas.length)}
          />
        </div>
        <div className="guided-capture-reflection" aria-live="polite">
          <span className="guided-capture-icon" aria-hidden="true">{area.icon}</span>
          <p className="guided-capture-eyebrow">{area.group}</p>
          <h2 id="life-area-title" ref={done ? undefined : headingRef} tabIndex={-1}>{area.title}</h2>
          <p className="guided-capture-prompt">{area.prompt}</p>
        </div>
        <CaptureForm
          key={formKey}
          mode="thought"
          autoFocus={formKey > 0}
          onSavingChange={setSaving}
          onCancel={() => setFormKey((key) => key + 1)}
          onCaptured={({ task }) => {
            setSaved((previous) => ({ title: task.title, count: (previous?.count ?? 0) + 1 }));
            setFormKey((key) => key + 1);
            bump();
          }}
        />
        <p className="guided-capture-reassurance">{strings.guidedCaptureDestination}</p>
        <nav className="guided-capture-navigation" aria-label={strings.guidedCapture}>
          <button type="button" className="btn" disabled={saving || index === 0}
            onClick={() => goTo(areas[index - 1]!.id)}>
            {strings.guidedCaptureBack}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={next}>
            {strings.guidedCaptureSkip}
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={next}>
            {index === areas.length - 1 ? strings.guidedCaptureFinish : strings.guidedCaptureNext}
          </button>
        </nav>
      </section>

      {saved ? (
        <p className="guided-capture-saved" role="status">
          <span aria-hidden="true">✓ </span>
          {strings.guidedCaptureSaved(saved.title, saved.count)}
        </p>
      ) : null}

      {done ? (
        <section className="guided-capture-card guided-capture-finish stack">
          <span className="guided-capture-icon" aria-hidden="true">🌤️</span>
          <h2 ref={headingRef} tabIndex={-1}>{strings.guidedCaptureDoneTitle}</h2>
          <p>{strings.guidedCaptureDoneHint}</p>
          <Link to="/inbox" className="btn btn-primary">{strings.guidedCaptureInbox}</Link>
          <button type="button" className="btn" onClick={() => goTo(areas[0]!.id)}>
            {strings.guidedCaptureRestart}
          </button>
        </section>
      ) : <p className="guided-capture-mental-load">{strings.guidedCaptureMentalLoad}</p>}

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
