import { useStrings } from "../lib/strings";
import { TagManager } from "../components/TagManager";
import { PageHeader } from "../components/PageHeader";

export function TagsPage() {
  const strings = useStrings();
  return (
    <div>
      <PageHeader
        title={strings.manageTags}
      />
      <TagManager />
    </div>
  );
}
