import { useStrings } from "../lib/strings";

function fileBadge(file: File): string {
  if (file.type.startsWith("image/")) return "IMG";
  if (file.type === "application/pdf") return "PDF";
  return "FILE";
}

export function PendingMaterialPreview({
  files,
}: {
  files: readonly File[];
}) {
  const strings = useStrings();
  if (files.length === 0) return null;

  return (
    <section
      className="pending-material-preview"
      aria-label={strings.pendingAttachments(files.length)}
    >
      {files.map((file, index) => (
        <figure className="pending-material-item" key={`${file.name}-${file.size}-${index}`}>
          <span className="pending-material-file" aria-hidden="true">
            {fileBadge(file)}
          </span>
          <figcaption>
            <strong>{file.name}</strong>
            <small>{strings.pendingUpload}</small>
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
