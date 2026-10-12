import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { StepComposer } from "./StepComposer";

export function InlineSuccessorComposer({
  predecessorId,
  onCancel,
  onCreated,
}: {
  predecessorId: number;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();

  const create = async (steps: Array<{ title: string; dueDate?: string | null; scheduledDate?: string | null }>) => {
    const step = steps[0];
    if (!step) return;
    await api.createTaskSuccessor(predecessorId, {
      ...step,
      createdByMemberId: currentMemberId,
      status: "actionable",
    });
    bump();
    onCreated();
  };

  return (
    <StepComposer
      inputIdPrefix={`inline-successor-title-${predecessorId}`}
      label={strings.addSuccessor}
      placeholder={strings.successorPlaceholder}
      submitLabel={strings.save}
      onCancel={onCancel}
      onSubmit={create}
      singleStep
    />
  );
}
