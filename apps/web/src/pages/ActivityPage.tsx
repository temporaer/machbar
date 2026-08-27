import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "@machbar/shared";
import { useSearchParams } from "react-router-dom";
import { ActivityFeed } from "../components/ActivityFeed";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncStates";
import { api, type ActivityFilters } from "../lib/api";

const PAGE_SIZE = 25;

function positiveInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function activityFiltersFromSearchParams(params: URLSearchParams): ActivityFilters {
  const filters: ActivityFilters = {};
  const actorId = positiveInteger(params.get("actorId"));
  const taskId = positiveInteger(params.get("taskId"));
  const projectId = positiveInteger(params.get("projectId"));
  if (actorId !== undefined) filters.actorId = actorId;
  if (taskId !== undefined) filters.taskId = taskId;
  if (projectId !== undefined) filters.projectId = projectId;
  return filters;
}

export function ActivityPage() {
  const [searchParams] = useSearchParams();
  const filters = activityFiltersFromSearchParams(searchParams);
  const filterKey = `${filters.actorId ?? ""}:${filters.taskId ?? ""}:${filters.projectId ?? ""}`;
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const id = ++requestId.current;
    cursor ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const page = await api.getActivity({
        ...filters,
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
      });
      if (id !== requestId.current) return;
      setEvents((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id !== requestId.current) return;
      cursor ? setLoadingMore(false) : setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    setEvents([]);
    setNextCursor(null);
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  return (
    <div>
      <div className="page-header">
        <h1>Aktivitäten</h1>
      </div>
      <p className="page-subtitle">Die neuesten Änderungen an Aufgaben und Projekten.</p>

      {loading ? <LoadingState /> : null}
      {!loading && error && events.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : null}
      {!loading && !error && events.length === 0 ? (
        <EmptyState message="Noch keine Aktivitäten vorhanden." />
      ) : null}
      {events.length > 0 ? <ActivityFeed events={events} /> : null}
      {error && events.length > 0 ? (
        <ErrorState message={error} onRetry={() => void load(nextCursor ?? undefined)} />
      ) : null}
      {!error && nextCursor ? (
        <button
          type="button"
          className="btn btn-block activity-load-more"
          disabled={loadingMore}
          onClick={() => void load(nextCursor)}
        >
          {loadingMore ? "Wird geladen …" : "Mehr laden"}
        </button>
      ) : null}
    </div>
  );
}
