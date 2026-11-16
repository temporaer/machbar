import { describe, expect, it } from "vitest";
import type { Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { makeTask } from "../test/fixtures";
import { buildProjectAiPromptText } from "./projectAiPrompt";

const markdownRenderer = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

function renderedElements(markdown: string) {
  const tree = markdownRenderer.runSync(markdownRenderer.parse(markdown)) as Root;
  const links: string[] = [];
  const images: { src: string; alt: string; title: string | undefined }[] = [];
  const texts: string[] = [];
  const footnoteReferenceHrefs: string[] = [];
  const footnoteDefinitionIds: string[] = [];
  const footnoteBodies: string[] = [];
  const blockquotes: string[] = [];
  const listItems: string[] = [];
  const textContent = (node: RootContent | Root): string =>
    node.type === "text"
      ? node.value
      : node.type === "root" || node.type === "element"
        ? node.children.map(textContent).join("")
        : "";
  const visit = (node: RootContent | Root) => {
    if (node.type === "text") texts.push(node.value);
    if (node.type === "element" && node.tagName === "a") {
      links.push(String(node.properties.href));
      if (node.properties.dataFootnoteRef != null) {
        footnoteReferenceHrefs.push(String(node.properties.href));
      }
    }
    if (node.type === "element" && node.tagName === "img") {
      images.push({
        src: String(node.properties.src),
        alt: String(node.properties.alt),
        title: node.properties.title == null
          ? undefined
          : String(node.properties.title),
      });
    }
    if (node.type === "element" && node.tagName === "li") {
      const id = node.properties.id;
      if (typeof id === "string" && id.startsWith("user-content-fn-")) {
        footnoteDefinitionIds.push(id);
        footnoteBodies.push(textContent(node).replace(/\s+/g, " ").trim());
      } else {
        listItems.push(textContent(node).replace(/\s+/g, " ").trim());
      }
    }
    if (node.type === "element" && node.tagName === "blockquote") {
      blockquotes.push(textContent(node).replace(/\s+/g, " ").trim());
    }
    if (node.type === "root" || node.type === "element") {
      node.children.forEach(visit);
    }
  };
  visit(tree);
  return {
    links,
    images,
    texts,
    footnoteReferenceHrefs,
    footnoteDefinitionIds,
    footnoteBodies,
    blockquotes,
    listItems,
  };
}

describe("buildProjectAiPromptText", () => {
  it("starts with the prompt and preserves only selected material Markdown", () => {
    const selected = makeTask({
      id: 8,
      title: "Versicherungsbedingungen",
      kind: "reference",
      notes: "[Quelle][policy]\n\n**Fristen beachten.**\n\n[policy]: https://example.test/policy",
    });
    const unselected = makeTask({
      id: 9,
      title: "Nicht ausgewählt",
      kind: "reference",
      notes: "Nicht in den Export übernehmen.",
    });

    const result = buildProjectAiPromptText("Fasse die Fristen zusammen.", [
      { task: selected, parentTitles: ["Versicherung prüfen"] },
    ]);

    expect(result).toBe(
      [
        "Fasse die Fristen zusammen.",
        "---",
        "## Versicherungsbedingungen",
        "Versicherung prüfen",
        "[Quelle](<https://example.test/policy>)\n\n**Fristen beachten.**",
      ].join("\n\n"),
    );
    expect(result).toContain("**Fristen beachten.**");
    expect(result).toContain("[Quelle](<https://example.test/policy>)");
    expect(result).not.toContain(unselected.title);
    expect(result).not.toContain(unselected.notes);
  });

  it("supports a prompt without selected material", () => {
    expect(buildProjectAiPromptText("Bitte brainstormen.", [])).toBe(
      "Bitte brainstormen.",
    );
  });

  it("resolves linked image references before removing their definitions", () => {
    const task = makeTask({
      id: 10,
      title: "Diagramm",
      kind: "reference",
      notes: [
        "[![Diagram][image]][source]",
        "",
        '[image]: https://example.test/diagram.png "Figure"',
        "[source]: https://example.test/page",
      ].join("\n"),
    });

    const markdown = buildProjectAiPromptText("", [
      { task, parentTitles: [] },
    ]);
    const { links, images } = renderedElements(markdown);

    expect(links).toEqual(["https://example.test/page"]);
    expect(images).toEqual([{
      src: "https://example.test/diagram.png",
      alt: "Diagram",
      title: "Figure",
    }]);
  });

  it("preserves ampersands in rendered image URLs, titles, and alt text", () => {
    const task = makeTask({
      id: 11,
      title: "Diagramm",
      kind: "reference",
      notes: [
        "![Diagram &amp;amp;copy;][image]",
        "",
        '[image]: https://example.test/diagram.png?q=&amp;amp;copy; "Figure &amp;amp;copy;"',
      ].join("\n"),
    });

    const markdown = buildProjectAiPromptText("", [
      { task, parentTitles: [] },
    ]);
    const { images } = renderedElements(markdown);

    expect(images).toEqual([{
      src: "https://example.test/diagram.png?q=&amp;copy;",
      alt: "Diagram &amp;copy;",
      title: "Figure &amp;copy;",
    }]);
  });

  it("preserves Markdown punctuation in rendered image alt text", () => {
    const task = makeTask({
      id: 14,
      title: "Diagramm",
      kind: "reference",
      notes: [
        "![\\*Important\\* \\`inline\\`][image]",
        "",
        "[image]: https://example.test/diagram.png",
      ].join("\n"),
    });

    const markdown = buildProjectAiPromptText("", [
      { task, parentTitles: [] },
    ]);

    expect(renderedElements(markdown).images).toEqual([{
      src: "https://example.test/diagram.png",
      alt: "*Important* `inline`",
      title: undefined,
    }]);
  });

  it("keeps GFM footnotes section-local when combining materials", () => {
    const first = makeTask({
      id: 15,
      title: "Quelle A",
      kind: "reference",
      notes: "Claim[^1].\n\n[^1]: Important A",
    });
    const second = makeTask({
      id: 16,
      title: "Quelle B",
      kind: "reference",
      notes: "Claim[^1].\n\n[^1]: Important B",
    });

    const markdown = buildProjectAiPromptText("", [
      { task: first, parentTitles: [] },
      { task: second, parentTitles: [] },
    ]);
    const rendered = renderedElements(markdown);

    expect(rendered.footnoteBodies).toEqual(["Important A ↩", "Important B ↩"]);
    expect(rendered.footnoteReferenceHrefs).toHaveLength(2);
    expect(new Set(rendered.footnoteReferenceHrefs).size).toBe(2);
    expect(rendered.footnoteDefinitionIds).toHaveLength(2);
    expect(new Set(rendered.footnoteDefinitionIds).size).toBe(2);
  });

  it("preserves footnotes in reference-link labels", () => {
    const task = makeTask({
      id: 18,
      title: "Quelle mit Fußnote",
      kind: "reference",
      notes: [
        "[Claim[^1]][src]",
        "",
        "[^1]: Important annotation",
        "",
        "[src]: https://example.test/source",
      ].join("\n"),
    });

    const markdown = buildProjectAiPromptText("", [
      { task, parentTitles: [] },
    ]);
    const rendered = renderedElements(markdown);

    expect(rendered.links[0]).toBe("https://example.test/source");
    expect(rendered.footnoteReferenceHrefs).toHaveLength(1);
    expect(rendered.footnoteBodies).toEqual(["Important annotation ↩"]);
  });

  it("removes duplicate reference definitions before combining notes", () => {
    const first = makeTask({
      id: 12,
      title: "Quelle A",
      kind: "reference",
      notes: [
        "[Link][source]",
        "",
        "[source]: https://example.test/first",
        "[source]: https://example.test/second",
      ].join("\n"),
    });
    const second = makeTask({
      id: 13,
      title: "Quelle B",
      kind: "reference",
      notes: "Refer to [source] for context.",
    });

    const markdown = buildProjectAiPromptText("", [
      { task: first, parentTitles: [] },
      { task: second, parentTitles: [] },
    ]);
    const { links, texts } = renderedElements(markdown);

    expect(links).toEqual(["https://example.test/first"]);
    expect(texts).toContain("Refer to [source] for context.");
  });

  it("preserves blockquote and list boundaries when removing reference definitions", () => {
    const task = makeTask({
      id: 17,
      title: "Quelle",
      kind: "reference",
      notes: [
        "[Quoted][quote]",
        "",
        "> [quote]: https://example.test/quote",
        "> Important annotation",
        "",
        "[Listed][list]",
        "",
        "- [list]: https://example.test/list",
        "- List annotation",
      ].join("\n"),
    });

    const markdown = buildProjectAiPromptText("", [
      { task, parentTitles: [] },
    ]);
    const rendered = renderedElements(markdown);

    expect(rendered.links).toEqual([
      "https://example.test/quote",
      "https://example.test/list",
    ]);
    expect(rendered.blockquotes).toEqual(["Important annotation"]);
    expect(rendered.listItems).toEqual(["", "List annotation"]);
  });
});
