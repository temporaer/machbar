import { Fragment, type ReactNode } from "react";

const tokenPattern =
  /(?:https?:\/\/|www\.)[^\s<]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ()/-]{5,}\d/gi;

function phoneHref(value: string, source: string, start: number, end: number): string | null {
  const before = source[start - 1] ?? "";
  const after = source[end] ?? "";
  if (/[A-Z0-9]/i.test(before) || /[A-Z0-9]/i.test(after)) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
    return null;
  }
  if ((value.match(/\d/g) ?? []).length < 7) return null;
  return `tel:${value.replace(/[ ()/]/g, "")}`;
}

function linkFor(value: string, source: string, start: number, end: number) {
  if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value)) {
    return { href: `mailto:${value}`, external: false };
  }
  if (/^(?:https?:\/\/|www\.)/i.test(value)) {
    return {
      href: /^www\./i.test(value) ? `https://${value}` : value,
      external: true,
    };
  }
  const href = phoneHref(value, source, start, end);
  return href ? { href, external: false } : null;
}

export function ActionableText({ text, className }: { text: string; className?: string }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index;
    const raw = match[0];
    let value = raw;
    let trailing = "";
    if (/^(?:https?:\/\/|www\.|[A-Z0-9._%+-]+@)/i.test(value)) {
      const cleaned = value.replace(/[.,!?;:)]*$/, "");
      trailing = value.slice(cleaned.length);
      value = cleaned;
    }
    const end = start + value.length;
    const link = linkFor(value, text, start, end);

    if (start > cursor) nodes.push(text.slice(cursor, start));
    if (link) {
      nodes.push(
        <a
          key={`${start}-${value}`}
          href={link.href}
          {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          onClick={(event) => event.stopPropagation()}
        >
          {value}
        </a>,
      );
      if (trailing) nodes.push(trailing);
    } else {
      nodes.push(raw);
    }
    cursor = start + raw.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <span className={className}>{nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>)}</span>;
}
