import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "@machbar/shared";
import { Link } from "react-router-dom";
import { api, type ActivityFilters } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { ActivityFeed } from "./ActivityFeed";

const RECENT_ACTIVITY_LIMIT = 5;

function activityHref(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.taskId !== undefined) params.set("taskId", String(filters.taskId));
  if (filters.projectId !== undefined) params.set("projectId", String(filters.projectId));
  return `/mehr/aktivitaeten?${params.toString()}`;
}

export function RecentActivity({
  filters,
  idPrefix,
}: {
  filters: Pick<ActivityFilters, "taskId" | "projectId">;
  idPrefix: string;
}) {
  const { version } = useRefresh();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [needsLoad, setNeedsLoad] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const previousVersion = useRef(version);
  const filterKey = `${filters.taskId ?? ""}:${filters.projectId ?? ""}`;

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setNeedsLoad(false);
    setLoading(true);
    setError(null);
    try {
      const page = await api.getActivity({ ...filters, limit: RECENT_ACTIVITY_LIMIT });
      if (id !== requestId.current) return;
      setEvents(page.items);
      setLoaded(true);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [filters.projectId, filters.taskId]);

  useEffect(() => {
    requestId.current += 1;
    setEvents([]);
    setLoaded(false);
    setNeedsLoad(true);
    setLoading(false);
    setError(null);
  }, [filterKey]);

  useEffect(() => {
    if (version === previousVersion.current) return;
    previousVersion.current = version;
    requestId.current += 1;
    setLoaded(false);
    setNeedsLoad(true);
    setLoading(false);
    setError(null);
  }, [version]);

  useEffect(() => {
    if (open && needsLoad && !loading) void load();
  }, [load, loading, needsLoad, open]);

  useEffect(() => () => {
    requestId.current += 1;
  }, []);

  return (
    <details
      className="section contextual-activity"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="section-title">
        <span role="heading" aria-level={2}>Letzte Aktivitäten</span>
      </summary>
      <div className="contextual-activity-content">
        {loading ? <p className="text-muted contextual-activity-state" role="status">Wird geladen …</p> : null}
        {!loading && error ? (
          <div className="contextual-activity-state" role="alert">
            <span>Aktivitäten konnten nicht geladen werden.</span>{" "}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()}>
              Erneut versuchen
            </button>
          </div>
        ) : null}
        {!loading && loaded && events.length === 0 ? (
          <p className="text-muted contextual-activity-state">Noch keine Aktivitäten.</p>
        ) : null}
        {events.length > 0 ? (
          <ActivityFeed events={events} headingLevel={3} idPrefix={idPrefix} />
        ) : null}
        <Link className="contextual-activity-more" to={activityHref(filters)}>
          Alle Aktivitäten anzeigen
        </Link>
      </div>
    </details>
  );
}
