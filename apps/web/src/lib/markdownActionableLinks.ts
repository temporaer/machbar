import type { Link, PhrasingContent, Text } from "mdast";
export const actionableTokenPattern =
  /(?:tel:|sms:)\s*\+?\d[\d ()/-]{5,}\d|(?:mailto:)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ()/-]{5,}\d/gi;

function actionableLink(
  raw: string,
  source: string,
  start: number,
): { href: string; label: string } | null {
  const explicit = raw.match(/^(tel:|sms:)\s*(.+)$/i);
  if (explicit) {
    const scheme = explicit[1]?.toLowerCase();
    const value = explicit[2]?.trim() ?? "";
    return scheme && value
      ? { href: `${scheme}${value.replace(/[ ()/]/g, "")}`, label: value }
      : null;
  }
  if (/^mailto:/i.test(raw)) {
    return { href: raw, label: raw.slice("mailto:".length) };
  }
  if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(raw)) {
    return { href: `mailto:${raw}`, label: raw };
  }
  const before = source[start - 1] ?? "";
  const after = source[start + raw.length] ?? "";
  if (/[A-Z0-9]/i.test(before) || /[A-Z0-9]/i.test(after)) return null;
  if (
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(raw) ||
    /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)
  ) {
    return null;
  }
  if ((raw.match(/\d/g) ?? []).length < 7) return null;
  return { href: `tel:${raw.replace(/[ ()/]/g, "")}`, label: raw };
}

export function splitActionableText(node: Text): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(actionableTokenPattern)) {
    const start = match.index;
    const raw = match[0];
    const link = actionableLink(raw, node.value, start);
    if (start > cursor)
      nodes.push({ type: "text", value: node.value.slice(cursor, start) });
    if (link) {
      nodes.push({
        type: "link",
        url: link.href,
        children: [{ type: "text", value: link.label }],
      } satisfies Link);
    } else {
      nodes.push({ type: "text", value: raw });
    }
    cursor = start + raw.length;
  }
  if (cursor < node.value.length)
    nodes.push({ type: "text", value: node.value.slice(cursor) });
  return nodes;
}
