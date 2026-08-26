import { strings } from "../lib/strings";
import { TagManager } from "../components/TagManager";
import { PageHeader } from "../components/PageHeader";

export function TagsPage() {
  return (
    <div>
      <PageHeader
        title={strings.manageTags}
        hints={[{ text: strings.manageTagsPageHint }]}
      />
      <TagManager />
    </div>
  );
}
