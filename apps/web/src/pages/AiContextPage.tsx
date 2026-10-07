import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import type { HouseholdAiContext } from "@machbar/shared";

const emptyContext: HouseholdAiContext = {
  householdDescription: null,
  longTermDirection: null,
  suggestionGuidance: null,
};

export function AiContextPage() {
  const strings = useStrings();
  const navigate = useNavigate();
  const { data, loading, error } = useAsync(() => api.getHouseholdAiContext(), []);
  const [draft, setDraft] = useState<HouseholdAiContext>(emptyContext);
  const draftInitialized = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !draftInitialized.current) {
      draftInitialized.current = true;
      setDraft(data);
    }
  }, [data]);

  const setField = (field: keyof HouseholdAiContext, value: string) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await api.updateHouseholdAiContext(draft);
      setDraft(result);
      setSaved(true);
    } catch (cause: unknown) {
      setSaveError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  const clear = () => {
    setSaved(false);
    setSaveError(null);
    setDraft(emptyContext);
  };

  return (
    <div className="ai-context-page">
      <div className="page-header">
        <button type="button" className="btn btn-ghost" onClick={() => navigate("/more")}>
          {strings.back}
        </button>
        <h1>{strings.aiContextTitle}</h1>
      </div>
      <p className="text-muted">{strings.aiContextIntro}</p>
      <div className="stack">
        <div className="field">
          <label htmlFor="household-description">{strings.householdDescription}</label>
          <p className="field-hint">{strings.householdDescriptionHint}</p>
          <textarea
            id="household-description"
            maxLength={3000}
            value={draft.householdDescription ?? ""}
            placeholder={strings.householdDescriptionPlaceholder}
            onChange={(event) => setField("householdDescription", event.target.value)}
            disabled={loading || saving}
            rows={6}
          />
        </div>
        <div className="field">
          <label htmlFor="long-term-direction">{strings.longTermDirection}</label>
          <p className="field-hint">{strings.longTermDirectionHint}</p>
          <textarea
            id="long-term-direction"
            maxLength={2000}
            value={draft.longTermDirection ?? ""}
            placeholder={strings.longTermDirectionPlaceholder}
            onChange={(event) => setField("longTermDirection", event.target.value)}
            disabled={loading || saving}
            rows={5}
          />
        </div>
        <div className="field">
          <label htmlFor="suggestion-guidance">{strings.suggestionGuidance}</label>
          <p className="field-hint">{strings.suggestionGuidanceHint}</p>
          <textarea
            id="suggestion-guidance"
            maxLength={2000}
            value={draft.suggestionGuidance ?? ""}
            placeholder={strings.suggestionGuidancePlaceholder}
            onChange={(event) => setField("suggestionGuidance", event.target.value)}
            disabled={loading || saving}
            rows={5}
          />
        </div>
        <p className="text-muted">{strings.aiContextRulesHint}</p>
        {error ? <p role="alert">{error}</p> : null}
        {saveError ? <p role="alert">{saveError}</p> : null}
        {saved ? <p role="status">{strings.saved}</p> : null}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={loading || saving}>
            {saving ? strings.saving : strings.save}
          </button>
          <button type="button" className="btn btn-ghost" onClick={clear} disabled={loading || saving}>
            {strings.aiContextClearDraft}
          </button>
        </div>
      </div>
    </div>
  );
}
