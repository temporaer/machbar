import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownNotes, transformMarkdownUrl } from "./MarkdownNotes";

describe("MarkdownNotes", () => {
  it("renders GFM, autolinks, and single newlines without raw HTML", () => {
    const { container } = render(
      <MarkdownNotes
        value={`first line
second line

- [x] done
- [ ] pending

www.example.com

<img src=x onerror="alert(1)">`}
      />,
    );

    expect(container.querySelector("br")).toBeInTheDocument();
    const [done, pending] = screen.getAllByRole("checkbox");
    expect(done).toBeChecked();
    expect(pending).not.toBeChecked();
    expect(screen.getByRole("link", { name: "www.example.com" })).toHaveAttribute(
      "href",
      "http://www.example.com",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
  });

  it("opens external web links safely but leaves non-web safe protocols local", () => {
    render(
      <MarkdownNotes
        value="[web](https://example.com) [mail](mailto:notes@example.com) [call](tel:+49123) [local](/notes) [bad](javascript:alert(1))"
      />,
    );

    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "mail" })).not.toHaveAttribute("target");
    expect(screen.getByRole("link", { name: "call" })).toHaveAttribute("href", "tel:+49123");
    expect(screen.getByRole("link", { name: "local" })).toHaveAttribute("href", "/notes");
    expect(screen.getByText("bad").closest("a")).toHaveAttribute("href", "");
  });

  it("makes bare phone, tel, sms, and mailto text actionable", () => {
    render(
      <MarkdownNotes value="072194390-387 tel:01604844887 sms:01604844887 mailto:foo@example.com" />,
    );

    expect(screen.getByRole("link", { name: "072194390-387" })).toHaveAttribute(
      "href",
      "tel:072194390-387",
    );
    expect(screen.getByRole("link", { name: "foo@example.com" })).toHaveAttribute(
      "href",
      "mailto:foo@example.com",
    );
    const phoneLinks = screen.getAllByRole("link", { name: "01604844887" });
    expect(phoneLinks[0]).toHaveAttribute("href", "tel:01604844887");
    expect(phoneLinks[1]).toHaveAttribute("href", "sms:01604844887");
  });

  it("renders valid Paperless images and document links through Machbar", () => {
    render(
      <MarkdownNotes
        value="![receipt](paperless:4711) [manual.pdf](paperless:4712)"
      />,
    );

    const image = screen.getByRole("img", { name: "receipt" });
    expect(image).toHaveAttribute(
      "src",
      "/api/integrations/paperless/documents/4711/thumbnail",
    );
    expect(image.closest("a")).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/4711/preview",
    );
    expect(screen.getByRole("link", { name: "manual.pdf" })).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/4712/download",
    );
  });

  it("shows a usable Paperless fallback when an image no longer loads", () => {
    render(<MarkdownNotes value="![missing scan](paperless:9)" />);

    fireEvent.error(screen.getByRole("img", { name: "missing scan" }));

    expect(screen.getByRole("link", { name: "missing scan" })).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/9/preview",
    );
  });
});

describe("transformMarkdownUrl", () => {
  it.each([
    ["/projects/3", "/projects/3"],
    ["../note", "../note"],
    ["#heading", "#heading"],
    ["https://example.com", "https://example.com"],
    ["HTTP://example.com", "HTTP://example.com"],
    ["mailto:notes@example.com", "mailto:notes@example.com"],
    ["tel:+491234", "tel:+491234"],
    ["sms:+491234", "sms:+491234"],
    ["javascript:alert(1)", ""],
    ["data:text/html,test", ""],
    ["file:///etc/passwd", ""],
    ["attachment:12", ""],
    ["paperless:12", "paperless:12"],
    ["paperless:0", ""],
    ["paperless:-1", ""],
    ["paperless:1/path", ""],
    ["paperless:not-a-number", ""],
    ["paperless:999999999999999999999", ""],
    ["//example.com", ""],
    ["\\\\example.com", ""],
    ["java\nscript:alert(1)", ""],
  ])("transforms %s safely", (url, expected) => {
    expect(transformMarkdownUrl(url)).toBe(expected);
  });
});
