import type { ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";

export function ProjectActivationDecisionFields({
  prompt,
  disabled,
  onChange,
}: {
  prompt: ProjectActivationPrompt;
  disabled: boolean;
  onChange: (prompt: ProjectActivationPrompt) => void;
}) {
  const strings = useStrings();
  const { members } = useIdentity();
  const needsPath = prompt.projects.some((project) => project.required.includes("progressPath"));

  return (
    <section className="card stack" aria-label={strings.commitmentResolutionTitle}>
      <h3>{strings.commitmentResolutionTitle}</h3>
      <p className="text-muted">{strings.commitmentResolutionHint}</p>
      {prompt.projects.filter((project) => project.required.includes("driver")).map((project) => (
        <div className="field" key={project.projectId}>
          <label htmlFor={`commitment-driver-${project.projectId}`}>
            {strings.commitmentDriverFor(project.title)}
          </label>
          <select
            id={`commitment-driver-${project.projectId}`}
            value={prompt.selectedDrivers[project.projectId] ?? ""}
            onChange={(event) => onChange({
              ...prompt,
              selectedDrivers: { ...prompt.selectedDrivers, [project.projectId]: Number(event.target.value) },
            })}
            disabled={disabled}
          >
            <option value="">{strings.noDriver}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </div>
      ))}
      {needsPath ? (
        <div className="field">
          <label htmlFor="commitment-next-action">{strings.commitmentNextActionLabel}</label>
          <input
            id="commitment-next-action"
            value={prompt.nextActionTitle}
            onChange={(event) => onChange({ ...prompt, nextActionTitle: event.target.value })}
            disabled={disabled}
            required
          />
        </div>
      ) : null}
    </section>
  );
}
