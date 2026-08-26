import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { WaitingGroupList } from "../components/WaitingGroupList";

export function WaitingPage() {
  const [actorTagId, setActorTagId] = useState<number | undefined>();
  const { data: tags } = useAsync(() => api.getTags(), []);
  const { data: groups, loading, error, reload } = useAsync(
    () => api.getWaiting(actorTagId),
    [actorTagId],
  );
  return (
    <div>
      <div className="page-header">
        <h1>{strings.waiting}</h1>
      </div>
      <div className="row" role="group" aria-label={strings.tagKindLabels.actor}>
        <button
          type="button"
          className="chip"
          aria-pressed={actorTagId === undefined}
          onClick={() => setActorTagId(undefined)}
        >
          {strings.allActors}
        </button>
        {(tags ?? [])
          .filter((tag) => tag.kind === "actor")
          .map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="chip"
              aria-pressed={actorTagId === tag.id}
              onClick={() => setActorTagId(tag.id)}
            >
              {tag.name}
            </button>
          ))}
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {groups ? <WaitingGroupList groups={groups} /> : null}
    </div>
  );
}
