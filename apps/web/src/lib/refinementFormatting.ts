import type { RefinementIssue } from "@machbar/shared";
import {
  getCatalog,
  type Locale,
  type TranslationCatalog,
} from "../i18n/catalog";

export interface FormattedRefinementIssue {
  label: string;
  explanation: string;
  actionLabel: string;
}

function dependencyTarget(issue: RefinementIssue): string | null {
  return issue.dependencyPath?.at(-1)?.title ?? null;
}

function actionLabel(
  issue: RefinementIssue,
  strings: TranslationCatalog,
): string {
  const target = dependencyTarget(issue);
  if (!target || issue.suggestedAction.targetTaskId === undefined) {
    return strings.refinementActionLabels[issue.suggestedAction.code];
  }
  switch (issue.suggestedAction.code) {
    case "clarify_task":
      return strings.refinementClarifyTarget(target);
    case "set_followup":
      return strings.refinementFollowUpTarget(target);
    case "resolve_blocker":
      return issue.blockingReason === "cycle"
        ? strings.refinementDependenciesTarget(target)
        : strings.refinementInspectTarget(target);
    default:
      return strings.refinementActionLabels[issue.suggestedAction.code];
  }
}

/**
 * Integration boundary for the shared/API refinement contract: the server
 * supplies stable codes, paths, and entity data only. All prose is generated
 * in the frontend catalog.
 */
export function formatRefinementIssue(
  issue: RefinementIssue,
  locale: Locale = "de",
): FormattedRefinementIssue {
  const strings = getCatalog(locale);
  const blockingReason =
    issue.code === "blocked_without_clear_path"
      ? issue.blockingReason
      : undefined;
  const target = dependencyTarget(issue);

  const label = blockingReason
    ? strings.refinementBlockingLabels[blockingReason]
    : strings.refinementIssueLabels[issue.code];

  let explanation = strings.refinementIssueExplanations[issue.code];
  if (blockingReason && target && issue.dependencyPath) {
    const relation =
      issue.dependencyPath.length === 2
        ? strings.refinementDependencyDirect(issue.entityTitle, target)
        : strings.refinementDependencyChain(issue.entityTitle, target);
    explanation = `${relation} ${strings.refinementBlockingExplanations[blockingReason]}`;
  }

  return {
    label,
    explanation,
    actionLabel: actionLabel(issue, strings),
  };
}
