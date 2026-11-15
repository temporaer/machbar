import type { ProjectMaterialItem } from "./projectMaterials";

export function buildProjectAiPromptText(
  prompt: string,
  materials: readonly ProjectMaterialItem[],
): string {
  const sections = prompt.trim() ? [prompt.trim()] : [];
  for (const { task, parentTitles } of materials) {
    const material = [`## ${task.title}`];
    if (parentTitles.length) material.push(parentTitles.join(" › "));
    if (task.notes) material.push(task.notes);
    sections.push(material.join("\n\n"));
  }
  return sections.join("\n\n---\n\n");
}
