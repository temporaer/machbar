import { useState } from "react";
import type { Member, Project, RefinementIssue } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { formatRefinementIssue } from "../lib/refinementFormatting";
import { BottomSheet } from "./BottomSheet";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

export function ActivationReadinessSheet({
  story,
  members,
  onClose,
  onActivate,
  onRepairOutcome,
  onRepairNextAction,
}: {
  story: Project;
  members: Member[];
  onClose: () => void;
  onActivate: (ownerMemberId?: number) => Promise<void>;
  onRepairOutcome: () => void;
  onRepairNextAction: () => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [selectedOwnerId, setSelectedOwnerId] = useState<number | null>(
    story.ownerMemberId,
  );
  const [saving, setSaving] = useState(false);
  const advisoryIssues =
    story.readiness?.issues.filter((issue) => issue.code !== "missing_driver") ??
    [];

  const repair = (issue: RefinementIssue) => {
    if (issue.code === "missing_outcome") {
      onRepairOutcome();
    } else if (issue.code === "missing_next_action") {
      onRepairNextAction();
    }
  };

  const activate = async () => {
    if (selectedOwnerId === null) return;
    setSaving(true);
    try {
      await onActivate(
        selectedOwnerId === story.ownerMemberId ? undefined : selectedOwnerId,
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={strings.activationPreparation}
      onClose={onClose}
      labelledBy="activation-readiness-title"
    >
      <div className="stack">
        <p className="text-muted">{strings.activationPreparationHint}</p>
        <MemberChoiceGroup
          label={strings.driver}
          idPrefix="activation-driver"
          members={members}
          value={selectedOwnerId}
          onChange={setSelectedOwnerId}
          unassignedLabel={null}
          disabled={saving}
          autoFocus
        />
        <p className="text-muted">{strings.activationDriverRequired}</p>

        <div className="stack">
          <strong>{strings.activationAdvisoryHeading}</strong>
          {advisoryIssues.length === 0 ? (
            <p className="text-muted">{strings.activationAdvisoryReady}</p>
          ) : (
            advisoryIssues.map((issue) => {
              const copy = formatRefinementIssue(issue, locale);
              return (
                <div
                  className="card"
                  key={`${issue.entityId}-${issue.code}`}
                >
                  <strong>{copy.label}</strong>
                  <p className="text-muted">{copy.explanation}</p>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => repair(issue)}
                  >
                    {copy.actionLabel}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={saving || selectedOwnerId === null}
            onClick={() => void activate()}
          >
            {advisoryIssues.length > 0
              ? strings.activateAnyway
              : strings.activateStory}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
