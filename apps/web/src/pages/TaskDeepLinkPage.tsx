import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTaskDetail } from "../lib/taskDetailContext";
import { strings } from "../lib/strings";

/** Route adapter for the existing state-driven task detail sheet. */
export function TaskDeepLinkPage() {
  const params = useParams<{ id: string }>();
  const taskId = Number(params.id);
  const navigate = useNavigate();
  const { openTaskId, open } = useTaskDetail();
  const opened = useRef(false);

  useEffect(() => {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      navigate("/heute", { replace: true });
      return;
    }
    open(taskId);
    // `open` is supplied by context and intentionally not a route dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, taskId]);

  useEffect(() => {
    if (openTaskId === taskId) {
      opened.current = true;
    } else if (opened.current && openTaskId === null) {
      navigate("/heute", { replace: true });
    }
  }, [navigate, openTaskId, taskId]);

  return <p className="text-muted">{strings.loading}</p>;
}
