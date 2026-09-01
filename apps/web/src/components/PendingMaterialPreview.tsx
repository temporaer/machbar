import { useEffect, useState } from "react";
import { useStrings } from "../lib/strings";

interface MaterialPreview {
  file: File;
  imageUrl: string | null;
}

export function PendingMaterialPreview({
  files,
}: {
  files: readonly File[];
}) {
  const strings = useStrings();
  const [previews, setPreviews] = useState<MaterialPreview[]>([]);

  useEffect(() => {
    const next = files.map((file) => ({
      file,
      imageUrl:
        file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : null,
    }));
    setPreviews(next);
    return () => {
      for (const preview of next) {
        if (preview.imageUrl) URL.revokeObjectURL(preview.imageUrl);
      }
    };
  }, [files]);

  if (previews.length === 0) return null;

  return (
    <section
      className="pending-material-preview"
      aria-label={strings.pendingAttachments(previews.length)}
    >
      {previews.map(({ file, imageUrl }, index) => (
        <figure className="pending-material-item" key={`${file.name}-${file.size}-${index}`}>
          {imageUrl ? (
            <img src={imageUrl} alt="" />
          ) : (
            <span className="pending-material-file" aria-hidden="true">PDF</span>
          )}
          <figcaption>
            <strong>{file.name}</strong>
            <small>{strings.pendingUpload}</small>
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
