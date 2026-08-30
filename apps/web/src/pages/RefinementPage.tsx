import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { RefinementIssue } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import { useRefinementActions } from "../lib/useRefinementActions";
import type { RefinementListItem } from "../lib/useRefinementActions";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { RefinementMatrix } from "../components/RefinementMatrix";
import type { RefinementMatrixSelection } from "../components/RefinementMatrix";
import { RefinementTaskRow } from "../components/RefinementTaskRow";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useIdentity } from "../lib/identity";
import { TagGroupingControl } from "../components/TagGroupingControl";
import {
  groupItemsByTagKind,
  type GroupableTagKind,
} from "../lib/tagGrouping";
import { CollapsibleGroup } from "../components/CollapsibleGroup";
import { PageHeader } from "../components/PageHeader";
import { formatRefinementIssue } from "../lib/refinementFormatting";
import { useLocale } from "../lib/locale";
import { ProjectEditSheet } from "../components/ProjectEditSheet";
import { StoryCriteriaSheet } from "../components/StoryCriteriaSheet";
import { QuickAdd } from "../components/QuickAdd";
import { BottomSheet } from "../components/BottomSheet";
import { flattenTasks } from "../lib/taskHelpers";
import "./RefinementPage.css";

interface RepairOrigin {
  issueKey: string;
  issueIndex: number;
}

interface TaskRepair extends RepairOrigin {
  opened: boolean;
}

interface ProjectRepair extends RepairOrigin {
  issue: RefinementIssue;
}

interface RefinementLocationState {
  refinementReturn?: RepairOrigin;
}

function refinementIssueKey(issue: RefinementIssue): string {
  return [
    issue.entityType,
    issue.entityId,
    issue.code,
    issue.suggestedAction.targetTaskId ?? "",
  ].join(":");
}

function scrollIntoViewIfNeeded(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    element.scrollIntoView?.({ block: "nearest" });
  }
}

function selectionLabel(
  selection: RefinementMatrixSelection,
  ownerNameById: Map<number, string>,
  strings: Strings,
): string {
  const ownerPart =
    selection.ownerId === null ? strings.shared : ownerNameById.get(selection.ownerId) ?? strings.unassigned;
  const sizePart =
    selection.size === undefined
      ? strings.allSizes
      : selection.size === "unestimated"
        ? strings.unestimated
        : strings.taskSizeLabels[selection.size];
  return `${ownerPart} · ${sizePart}`;
}

/**
 * "Arbeit klären" combines concrete project/task diagnostics with a
 * secondary owner × S/M/L/XL/unestimated view of work that is already in
 * the working system. Backlog-project tasks are intentionally absent until
 * activation; standalone work and tasks in active projects remain visible.
 */
export function RefinementPage() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { members } = useIdentity();
  const location = useLocation();
  const [selection, setSelection] = useState<RefinementMatrixSelection | null>(null);
  const [groupBy, setGroupBy] = useState<GroupableTagKind | null>(null);
  const [taskRepair, setTaskRepair] = useState<TaskRepair | null>(null);
  const [projectRepair, setProjectRepair] = useState<ProjectRepair | null>(null);
  const [pendingReturn, setPendingReturn] = useState<
    (RepairOrigin & { previousResult: object | null }) | null
  >(null);
  const issueRefs = useRef(new Map<string, HTMLElement>());
  const actions = useRefinementActions();
  const navigate = useNavigate();
  const taskDetail = useTaskDetail();
  const {
    data: issueResult,
    loading: issuesLoading,
    error: issuesError,
    reload: reloadIssues,
  } = useAsync(() => api.getRefinementIssues(), []);
  const {
    data: repairProject,
    loading: repairProjectLoading,
    error: repairProjectError,
    reload: reloadRepairProject,
  } = useAsync(
    () =>
      projectRepair
        ? api.getProject(projectRepair.issue.entityId)
        : Promise.resolve(null),
    [projectRepair?.issue.entityId],
  );

  const {
    data: ownerRows,
    loading: ownersLoading,
    error: ownersError,
    reload: reloadOwners,
  } = useAsync(() => api.getRefinementOwners({}), []);
  const {
    data: taskRows,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.getRefinementTasks({}), []);

  const ownerNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of ownerRows ?? []) {
      if (row.ownerId !== null && row.ownerName) map.set(row.ownerId, row.ownerName);
    }
    return map;
  }, [ownerRows]);

  const listItems = useMemo<RefinementListItem[]>(() => {
    if (!taskRows) return [];
    return taskRows;
  }, [taskRows]);

  const filteredItems = useMemo(() => {
    if (!selection) return listItems;
    return listItems.filter((item) => {
      if (item.effectiveOwnerId !== selection.ownerId) return false;
      if (selection.size === undefined) return true;
      if (selection.size === "unestimated") return item.size === null;
      return item.size === selection.size;
    });
  }, [listItems, selection]);
  const groupedItems = groupBy
    ? groupItemsByTagKind(filteredItems, groupBy, locale)
    : [{ tag: null, items: filteredItems }];

  const loading = issuesLoading || ownersLoading || tasksLoading;
  const error = issuesError ?? ownersError ?? tasksError;

  const beginReturn = (origin: RepairOrigin) => {
    setPendingReturn({
      ...origin,
      previousResult: issueResult,
    });
    reloadIssues();
  };

  useEffect(() => {
    if (!taskRepair) return;
    if (taskDetail.openTaskId !== null) {
      if (!taskRepair.opened) {
        setTaskRepair((current) =>
          current ? { ...current, opened: true } : current,
        );
      }
      return;
    }
    if (taskRepair.opened) {
      const origin = taskRepair;
      setTaskRepair(null);
      beginReturn(origin);
    }
  }, [taskDetail.openTaskId, taskRepair]);

  useEffect(() => {
    if (
      !pendingReturn ||
      !issueResult ||
      issueResult === pendingReturn.previousResult
    ) {
      return;
    }
    const issues = issueResult.issues;
    const target =
      issues.find(
        (candidate) =>
          refinementIssueKey(candidate) === pendingReturn.issueKey,
      ) ?? issues[Math.min(pendingReturn.issueIndex, issues.length - 1)];
    setPendingReturn(null);
    if (!target) return;
    const element = issueRefs.current.get(refinementIssueKey(target));
    if (!element) return;
    scrollIntoViewIfNeeded(element);
    element.focus();
  }, [issueResult, pendingReturn]);

  useEffect(() => {
    const returnTarget = (location.state as RefinementLocationState | null)
      ?.refinementReturn;
    if (!returnTarget || pendingReturn) return;
    setPendingReturn({
      ...returnTarget,
      previousResult: null,
    });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate, pendingReturn]);

  useEffect(() => {
    if (
      projectRepair?.issue.suggestedAction.code !== "plan_task" ||
      !repairProject
    ) {
      return;
    }
    const taskToPlan = flattenTasks(repairProject.tasks).find(
      (task) =>
        task.status !== "done" &&
        task.status !== "cancelled" &&
        !task.dueDate &&
        !task.scheduledDate,
    );
    if (!taskToPlan) return;
    const origin = projectRepair;
    setProjectRepair(null);
    setTaskRepair({ ...origin, opened: false });
    taskDetail.open(taskToPlan.id, "schedule");
  }, [projectRepair, repairProject, taskDetail]);

  const startTaskRepair = (
    issue: RefinementIssue,
    issueIndex: number,
    focus:
      | "title"
      | "owner"
      | "schedule"
      | "dependencies"
      | "subtasks"
      | undefined,
    taskId = issue.suggestedAction.targetTaskId ?? issue.entityId,
  ) => {
    const origin = {
      issueKey: refinementIssueKey(issue),
      issueIndex,
    };
    setTaskRepair({ ...origin, opened: false });
    taskDetail.open(taskId, focus);
  };

  const repair = (issue: RefinementIssue, issueIndex: number) => {
    if (issue.entityType === "project") {
      setProjectRepair({
        issue,
        issueKey: refinementIssueKey(issue),
        issueIndex,
      });
      return;
    }
    const focus =
      issue.suggestedAction.code === "clarify_task"
        ? "title"
        : issue.suggestedAction.code === "assign_task"
        ? "owner"
        : issue.suggestedAction.code === "set_followup" ||
            issue.suggestedAction.code === "follow_up"
          ? "dependencies"
          : issue.suggestedAction.code === "plan_task"
            ? "schedule"
          : issue.suggestedAction.code === "resolve_blocker"
            ? "dependencies"
            : issue.suggestedAction.code === "add_child"
              ? "subtasks"
              : undefined;
    startTaskRepair(issue, issueIndex, focus);
  };

  const openDetails = (issue: RefinementIssue, issueIndex: number) => {
    const origin = {
      issueKey: refinementIssueKey(issue),
      issueIndex,
    };
    if (issue.entityType === "task") {
      setTaskRepair({ ...origin, opened: false });
      taskDetail.open(issue.entityId);
      return;
    }
    navigate(`/projects/${issue.entityId}`, {
      state: { refinementReturn: origin } satisfies RefinementLocationState,
    });
  };

  const closeProjectRepair = () => {
    if (!projectRepair) return;
    const origin = projectRepair;
    setProjectRepair(null);
    beginReturn(origin);
  };

  return (
    <div>
      <PageHeader
        title={strings.refinement}
        hints={[
          {
            label: strings.clarificationNeeds,
            text: strings.clarificationNeedsHint,
          },
          {
            label: strings.effortGuide,
            text: strings.effortGuideHint,
          },
          {
            label: strings.refinementMatrixTitle,
            text: strings.refinementMatrixHint,
          },
          {
            label: strings.refinementListTitle,
            text: [strings.swipeHintSize, strings.swipeHintSizeChips],
          },
        ]}
      />
      <div className="projects-controls">
        <TagGroupingControl value={groupBy} onChange={setGroupBy} />
      </div>

      {loading ? <LoadingState /> : null}
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            reloadIssues();
            reloadOwners();
            reloadTasks();
          }}
        />
      ) : null}

      <section className="section" aria-labelledby="clarification-needs-heading">
        <h2 className="section-title" id="clarification-needs-heading">
          {strings.clarificationNeeds}
        </h2>
        {issueResult?.issues.length === 0 ? (
          <EmptyState message={strings.clarificationNeedsEmpty} />
        ) : null}
        <div className="clarification-issue-list">
          {issueResult?.issues.map((issue, issueIndex) => (
            (() => {
              const copy = formatRefinementIssue(issue, locale);
              const issueKey = refinementIssueKey(issue);
              return (
                <article
                  className={`card clarification-issue clarification-issue--${issue.severity}`}
                  key={issueKey}
                  ref={(element) => {
                    if (element) issueRefs.current.set(issueKey, element);
                    else issueRefs.current.delete(issueKey);
                  }}
                  tabIndex={-1}
                >
                  <div>
                    <strong>{issue.entityTitle}</strong>
                    {issue.projectTitle && issue.entityType === "task" ? (
                      <span className="text-muted"> · {issue.projectTitle}</span>
                    ) : null}
                  </div>
                  <div className="clarification-issue-label">{copy.label}</div>
                  <p className="text-muted">{copy.explanation}</p>
                  <div className="clarification-issue-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => repair(issue, issueIndex)}
                    >
                      {copy.actionLabel}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openDetails(issue, issueIndex)}
                    >
                      {strings.taskDetails}
                    </button>
                  </div>
                </article>
              );
            })()
          ))}
        </div>
      </section>

      {ownerRows ? (
        <div className="section refinement-secondary">
          <div className="section-title">{strings.effortGuide}</div>
          <RefinementMatrix
            rows={ownerRows}
            selection={selection}
            onSelect={setSelection}
            members={members}
          />
        </div>
      ) : null}

      <div className="section" style={{ marginTop: 16 }}>
        <div className="row-between section-title">
          <span>{strings.refinementListTitle}</span>
          {selection ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelection(null)}>
              {strings.resetFilter}
            </button>
          ) : null}
        </div>
        {selection ? (
          <p className="text-muted refinement-filter-label">
            {strings.filteredBy}:{" "}
            {selectionLabel(selection, ownerNameById, strings)}
          </p>
        ) : null}
        {taskRows && filteredItems.length === 0 ? <EmptyState message={strings.refinementEmpty} /> : null}
        {filteredItems.length > 0
          ? groupedItems.map((group) => (
              groupBy ? (
                <CollapsibleGroup
                  key={`${groupBy}-${group.tag?.id ?? "none"}`}
                  title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
                  headingLevel={3}
                >
                  <ul className="list refinement-list" style={{ padding: 0, margin: 0 }}>
                    {group.items.map((item) => (
                      <RefinementTaskRow
                        key={item.id}
                        task={item}
                        ownerName={item.effectiveOwnerId !== null ? ownerNameById.get(item.effectiveOwnerId) ?? null : null}
                        actions={actions}
                      />
                    ))}
                  </ul>
                </CollapsibleGroup>
              ) : (
              <section key="all">
                <ul className="list refinement-list" style={{ padding: 0, margin: 0 }}>
                  {group.items.map((item) => (
                    <RefinementTaskRow
                      key={item.id}
                      task={item}
                      ownerName={item.effectiveOwnerId !== null ? ownerNameById.get(item.effectiveOwnerId) ?? null : null}
                      actions={actions}
                    />
                  ))}
                </ul>
              </section>
              )
            ))
          : null}
      </div>
      {projectRepair ? (
        repairProject ? (
          projectRepair.issue.suggestedAction.code === "add_outcome" ? (
            <StoryCriteriaSheet
              story={repairProject}
              onClose={closeProjectRepair}
            />
          ) : projectRepair.issue.suggestedAction.code === "add_next_action" ? (
            <QuickAdd
              projectId={repairProject.id}
              autoOpen
              onAutoOpenClose={closeProjectRepair}
            />
          ) : projectRepair.issue.suggestedAction.code === "plan_task" ? (
            <BottomSheet
              title={strings.refinement}
              onClose={closeProjectRepair}
              labelledBy="refinement-project-repair-title"
            >
              <EmptyState message={strings.noTasks} />
            </BottomSheet>
          ) : (
            <ProjectEditSheet
              project={repairProject}
              focusField={
                projectRepair.issue.suggestedAction.code === "assign_driver"
                  ? "driver"
                  : projectRepair.issue.suggestedAction.code ===
                      "review_completion"
                    ? "completion"
                    : undefined
              }
              onClose={closeProjectRepair}
              onDeleted={closeProjectRepair}
            />
          )
        ) : (
          <BottomSheet
            title={strings.refinement}
            onClose={closeProjectRepair}
            labelledBy="refinement-project-repair-title"
          >
            {repairProjectLoading ? <LoadingState /> : null}
            {repairProjectError ? (
              <ErrorState
                message={repairProjectError}
                onRetry={reloadRepairProject}
              />
            ) : null}
          </BottomSheet>
        )
      ) : null}
    </div>
  );
}
