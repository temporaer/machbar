import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useStrings } from "../lib/strings";

/** Route adapter for the existing state-driven task detail sheet. */
export function TaskDeepLinkPage() {
  const strings = useStrings();
  const params = useParams<{ id: string }>();
  const taskId = Number(params.id);
  const navigate = useNavigate();
  const { openTaskId, open } = useTaskDetail();
  const workflow = useTaskWorkflow();
  const openedOpeningId = useRef<number | null>(null);
  const openedTaskId = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      navigate("/today", { replace: true });
      return;
    }
    open(taskId);
    // `open` is supplied by context and intentionally not a route dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, taskId]);

  useEffect(() => {
    if (openTaskId === taskId) {
      openedOpeningId.current = workflow.detailOpeningId;
      openedTaskId.current = taskId;
    } else if (
      openedOpeningId.current !== null &&
      openedTaskId.current === taskId &&
      openTaskId === null &&
      workflow.detailOpeningId !== openedOpeningId.current
    ) {
      navigate("/today", { replace: true });
    }
  }, [navigate, openTaskId, taskId, workflow.detailOpeningId]);

  return <p className="text-muted">{strings.loading}</p>;
}
