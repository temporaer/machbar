import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { InlineTaskComposer } from "./InlineTaskComposer";

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

  const create = async (title: string) => {
    await api.createTaskSuccessor(predecessorId, {
      title,
      createdByMemberId: currentMemberId,
      status: "actionable",
    });
    bump();
    onCreated();
  };

  return (
    <InlineTaskComposer
      inputId={`inline-successor-title-${predecessorId}`}
      label={strings.addSuccessor}
      placeholder={strings.successorPlaceholder}
      onCancel={onCancel}
      onSave={create}
    />
  );
}
