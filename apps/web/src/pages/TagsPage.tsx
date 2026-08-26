import { strings } from "../lib/strings";
import { TagManager } from "../components/TagManager";

export function TagsPage() {
  return (
    <div>
      <div className="page-header">
        <h1>{strings.manageTags}</h1>
      </div>
      <p className="page-subtitle">{strings.manageTagsPageHint}</p>
      <TagManager />
    </div>
  );
}
