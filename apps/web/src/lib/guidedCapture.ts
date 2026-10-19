import type { Strings } from "./strings";

// Array order is the suggested journey, not a task classification.
const lifeAreaGroups = [
  { id: "home", areas: [
    { id: "home", icon: "🏡" },
    { id: "household", icon: "🧺" },
    { id: "admin", icon: "📬" },
    { id: "digital", icon: "💻" },
  ] },
  { id: "people", areas: [
    { id: "family", icon: "🌱" },
    { id: "relationships", icon: "💛" },
    { id: "community", icon: "🤝" },
  ] },
  { id: "growth", areas: [
    { id: "health", icon: "🌿" },
    { id: "movement", icon: "🚲" },
    { id: "career", icon: "🧭" },
    { id: "learning", icon: "📚" },
  ] },
  { id: "resources", areas: [
    { id: "finances", icon: "☂️" },
    { id: "mobility", icon: "🚆" },
    { id: "travel", icon: "🧳" },
  ] },
  { id: "joy", areas: [
    { id: "hobbies", icon: "🎨" },
    { id: "celebrations", icon: "🎈" },
  ] },
] as const;

export function guidedCaptureCatalog(strings: Strings) {
  return lifeAreaGroups.map((group) => ({
    id: group.id,
    title: strings.guidedCaptureGroups[group.id],
    areas: group.areas.map((area) => ({
      ...area,
      ...strings.guidedCaptureAreas[area.id],
    })),
  }));
}
