import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ReviewCategory,
  ReviewItem,
  ReviewReason,
  Task,
} from "@machbar/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useTaskActions } from "../lib/useTaskActions";
import {
  useTaskDetail,
  type TaskDetailFocusField,
} from "../lib/taskDetailContext";
import { useStrings } from "../lib/strings";
import { ErrorState, EmptyState, LoadingState } from "../components/AsyncStates";
import { PageHeader } from "../components/PageHeader";
import { RefinementTools } from "../components/RefinementTools";
import { ChildPolicyPrompt } from "../components/ChildPolicyPrompt";
import { hasProjectProgressPath } from "../lib/projectCommitments";
import "./ReviewPage.css";

interface ReviewReturn {
  issueKey: string;
  issueIndex: number;
}

interface ReviewLocationState {
  reviewReturn?: ReviewReturn;
}

const categoryOrder: ReviewCategory[] = [
  "clarification_repair",
  "completion",
  "reconsider",
];

function reviewItemKey(item: ReviewItem): string {
  return `${item.entityType}:${item.entityId}:${item.category}:${item.reason}`;
}

export function ReviewPage() {
  const strings = useStrings();
  const navigate = useNavigate();
  const location = useLocation();
  const taskDetail = useTaskDetail();
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [taskReturn, setTaskReturn] = useState<ReviewReturn | null>(null);
  const [taskSheetOpened, setTaskSheetOpened] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  const {
    data: items,
    loading: itemsLoading,
    error: itemsError,
    reload: reloadItems,
  } = useAsync(() => api.getReviewItems(), []);
  const {
    data: projects,
    loading: projectsLoading,
    error: projectsError,
    reload: reloadProjects,
  } = useAsync(() => api.getProjects(), []);
  const {
    data: tasks,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.searchTasks({}), []);
  const projectActions = useProjectActions(projects ?? []);
  const taskActions = useTaskActions();
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const taskById = useMemo(
    () => new Map((tasks ?? []).map((task) => [task.id, task])),
    [tasks],
  );
  const groups = categoryOrder
    .map((category) => ({
      category,
      items: (items ?? []).filter((item) => item.category === category),
    }))
    .filter((group) => group.items.length > 0);

  const focusReturnedItem = (origin: ReviewReturn) => {
    const candidates = items ?? [];
    const target =
      candidates.find((item) => reviewItemKey(item) === origin.issueKey) ??
      candidates[Math.min(origin.issueIndex, candidates.length - 1)];
    if (!target) return;
    requestAnimationFrame(() => {
      const element = itemRefs.current.get(reviewItemKey(target));
      element?.scrollIntoView?.({ block: "nearest" });
      element?.focus();
    });
  };

  useEffect(() => {
    const origin = (location.state as ReviewLocationState | null)?.reviewReturn;
    if (!origin || !items) return;
    focusReturnedItem(origin);
    navigate(location.pathname, { replace: true, state: null });
  }, [items, location.pathname, location.state, navigate]);

  useEffect(() => {
    if (!taskReturn) return;
    if (taskDetail.openTaskId !== null) {
      setTaskSheetOpened(true);
      return;
    }
    if (!taskSheetOpened) return;
    const origin = taskReturn;
    setTaskReturn(null);
    setTaskSheetOpened(false);
    reloadItems();
    focusReturnedItem(origin);
  }, [taskDetail.openTaskId, taskReturn, taskSheetOpened]);

  const reasonText = (reason: ReviewReason): string => {
    switch (reason) {
      case "missing_driver":
        return strings.reviewReasonMissingDriver;
      case "no_viable_progress_path":
        return strings.reviewReasonNoProgressPath;
      case "xl_without_children":
        return strings.reviewReasonXlWithoutChildren;
      case "waiting_without_followup":
        return strings.reviewReasonWaiting;
      case "broken_blocker_path":
        return strings.reviewReasonBlocked;
      case "completion_review":
        return strings.reviewReasonCompletion;
      case "active_stale":
      case "backlog_stale":
      case "backlog_due":
      case "standalone_someday_stale":
        return strings.reviewReasonAge;
      default:
        return strings.reviewReasonGeneric;
    }
  };
  const categoryLabel = (category: ReviewCategory): string => {
    switch (category) {
      case "clarification_repair":
        return strings.reviewCategoryStructure;
      case "completion":
        return strings.reviewCategoryCompletion;
      case "reconsider":
      default:
        return strings.reviewCategoryRoutine;
    }
  };
  const actionLabel = (item: ReviewItem): string => {
    switch (item.suggestedAction.code) {
      case "assign_driver":
        return strings.assignDriver;
      case "add_next_action":
        return strings.addNextAction;
      case "set_followup":
        return strings.reviewActionSetFollowup;
      case "resolve_blocker":
        return strings.reviewActionResolveBlocker;
      case "add_child":
        return strings.addChild;
      case "review_completion":
        return strings.completeStory;
      case "review_project":
      case "review_task":
      default:
        return strings.reviewOpenDetails;
    }
  };
  const openTask = (
    taskId: number,
    item: ReviewItem,
    issueIndex: number,
    focus?: TaskDetailFocusField,
  ) => {
    setTaskReturn({ issueKey: reviewItemKey(item), issueIndex });
    setTaskSheetOpened(false);
    taskDetail.open(taskId, focus);
  };
  const repair = (item: ReviewItem, issueIndex: number) => {
    const targetId = item.suggestedAction.targetEntityId ?? item.entityId;
    switch (item.suggestedAction.code) {
      case "assign_driver":
        navigate(`/projects/${item.projectId ?? item.entityId}?focus=driver`, {
          state: { reviewReturn: { issueKey: reviewItemKey(item), issueIndex } },
        });
        return;
      case "add_next_action":
        navigate(`/projects/${item.projectId ?? item.entityId}?focus=next-action`, {
          state: { reviewReturn: { issueKey: reviewItemKey(item), issueIndex } },
        });
        return;
      case "review_completion":
        navigate(`/projects/${item.projectId ?? item.entityId}?focus=completion`, {
          state: { reviewReturn: { issueKey: reviewItemKey(item), issueIndex } },
        });
        return;
      case "set_followup":
        openTask(targetId, item, issueIndex, "waiting");
        return;
      case "resolve_blocker":
        openTask(targetId, item, issueIndex, "dependencies");
        return;
      case "add_child":
        openTask(targetId, item, issueIndex, "subtasks");
        return;
      case "review_task":
        openTask(targetId, item, issueIndex);
        return;
      case "review_project":
      default:
        navigate(`/projects/${item.projectId ?? item.entityId}`, {
          state: { reviewReturn: { issueKey: reviewItemKey(item), issueIndex } },
        });
    }
  };
  const openDetails = (item: ReviewItem, issueIndex: number) => {
    if (item.entityType === "task") {
      openTask(item.entityId, item, issueIndex);
      return;
    }
    navigate(`/projects/${item.entityId}`, {
      state: { reviewReturn: { issueKey: reviewItemKey(item), issueIndex } },
    });
  };

  const projectDecisionButtons = (item: ReviewItem) => {
    const project = projectById.get(item.entityId);
    if (!project) return null;
    const displayed = projectActions.retained.get(project.id)?.story ?? project;
    return (
      <>
        {displayed.availableActions.includes("activate") && hasProjectProgressPath(displayed) ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (displayed.ownerMemberId === null) {
                navigate(`/projects/${displayed.id}?focus=driver`, {
                  state: {
                    reviewReturn: {
                      issueKey: reviewItemKey(item),
                      issueIndex: (items ?? []).indexOf(item),
                    },
                  },
                });
                return;
              }
              void projectActions.activate(displayed);
            }}
          >
            {strings.reviewStart}
          </button>
        ) : null}
        {displayed.availableActions.includes("return_to_backlog") ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void projectActions.runAction(displayed, "return_to_backlog")}
          >
            {strings.reviewBacklog}
          </button>
        ) : null}
        {displayed.availableActions.includes("complete") ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (displayed.acceptanceCriteria.some((criterion) => !criterion.checked)) {
                navigate(`/projects/${displayed.id}?focus=completion`, {
                  state: {
                    reviewReturn: {
                      issueKey: reviewItemKey(item),
                      issueIndex: (items ?? []).indexOf(item),
                    },
                  },
                });
                return;
              }
              void projectActions.runAction(displayed, "complete");
            }}
          >
            {strings.completeStory}
          </button>
        ) : null}
        {displayed.availableActions.includes("archive") ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void projectActions.archive(displayed)}
          >
            {strings.reviewArchive}
          </button>
        ) : null}
        {item.category === "reconsider" ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void projectActions.acknowledgeReview(displayed)}
          >
            {strings.reviewKeep}
          </button>
        ) : null}
      </>
    );
  };

  const taskDecisionButtons = (item: ReviewItem) => {
    const task = taskById.get(item.entityId);
    if (!task) return null;
    const displayed: Task = taskActions.retained.get(task.id) ?? task;
    return (
      <>
        {displayed.status !== "actionable" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void taskActions.setStatus(displayed, "actionable")}
          >
            {strings.classifyAsAction}
          </button>
        ) : null}
        {displayed.status !== "someday" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void taskActions.setStatus(displayed, "someday")}
          >
            {strings.reviewSomeday}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => taskActions.requestCancel(displayed)}
        >
          {strings.reviewCancel}
        </button>
        {item.category === "reconsider" ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void taskActions.acknowledgeReview(displayed)}
          >
            {strings.reviewKeep}
          </button>
        ) : null}
      </>
    );
  };
  const isAcknowledged = (item: ReviewItem): boolean => {
    if (item.entityType === "project") {
      const source = projectById.get(item.entityId);
      const retained = projectActions.retained.get(item.entityId)?.story;
      return Boolean(
        source &&
          retained?.reviewedAt &&
          retained.reviewedAt !== source.reviewedAt,
      );
    }
    const source = taskById.get(item.entityId);
    const retained = taskActions.retained.get(item.entityId);
    return Boolean(
      source &&
        retained?.reviewedAt &&
        retained.reviewedAt !== source.reviewedAt,
    );
  };

  const loading = itemsLoading || projectsLoading || tasksLoading;
  const error = itemsError ?? projectsError ?? tasksError;

  return (
    <div>
      <PageHeader title={strings.reviewTitle} hints={[{ text: strings.reviewHint }]} />
      {loading ? <LoadingState /> : null}
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            reloadItems();
            reloadProjects();
            reloadTasks();
          }}
        />
      ) : null}
      {items ? (
        <section className="section" aria-labelledby="review-queue-heading">
          <h2 id="review-queue-heading" className="section-title">
            {strings.reviewPrimaryQueue}
          </h2>
          {items.length === 0 ? <EmptyState message={strings.reviewEmpty} /> : null}
          {groups.map((group) => (
            <section className="review-group" key={group.category}>
              <h3>{categoryLabel(group.category)}</h3>
              <div className="review-list">
                {group.items.map((item) => {
                  const issueIndex = (items ?? []).indexOf(item);
                  return (
                  <article
                    className="card review-item"
                    key={reviewItemKey(item)}
                    ref={(element) => {
                      if (element) itemRefs.current.set(reviewItemKey(item), element);
                      else itemRefs.current.delete(reviewItemKey(item));
                    }}
                    tabIndex={-1}
                  >
                    <div className="review-item-heading">
                      <strong>{item.entityTitle}</strong>
                      {isAcknowledged(item) ? (
                        <span className="badge">{strings.reviewAcknowledged}</span>
                      ) : null}
                      {item.projectTitle && item.entityType === "task" ? (
                        <span className="text-muted"> · {item.projectTitle}</span>
                      ) : null}
                    </div>
                    <p>{reasonText(item.reason)}</p>
                    <div className="review-item-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => openDetails(item, issueIndex)}
                      >
                        {strings.reviewOpenDetails}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => repair(item, issueIndex)}
                      >
                        {actionLabel(item)}
                      </button>
                      {item.entityType === "project"
                        ? projectDecisionButtons(item)
                        : taskDecisionButtons(item)}
                    </div>
                  </article>
                  );
                })}
              </div>
            </section>
          ))}
        </section>
      ) : null}
      <details
        className="section review-planning-tools"
        open={planningOpen}
        onToggle={(event) => setPlanningOpen(event.currentTarget.open)}
      >
        <summary className="section-title disclosure-summary">
          {strings.reviewPlanningTools}
        </summary>
        {planningOpen ? (
          <>
            <p className="text-muted">{strings.reviewPlanningToolsHint}</p>
            <RefinementTools />
          </>
        ) : null}
      </details>
      {taskActions.pendingTask && taskActions.pendingAction ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction}
          onChoose={taskActions.resolvePolicy}
          onClose={taskActions.cancelPrompt}
        />
      ) : null}
    </div>
  );
}
