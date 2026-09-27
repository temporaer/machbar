export function ExternalRefBadge({
  refs,
}: {
  refs: readonly { summary: string; start: string }[];
}) {
  const ref = refs[0];
  if (!ref) return null;
  return (
    <p className="detail-meta-static">
      Kalender: {ref.summary} · {new Date(ref.start).toLocaleString()}
    </p>
  );
}
