import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LocaleProvider } from "../i18n/provider";
import { PaperlessAttachmentStrip } from "./PaperlessAttachmentStrip";
import { api } from "../lib/api";
import { RefreshProvider } from "../lib/refresh";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      getPaperlessStatus: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api, true);

function renderStrip(
  ui: ReactElement,
  options: { locale?: "de" | "en" } = {},
) {
  return render(
    <RefreshProvider>
      {options.locale ? (
        <LocaleProvider initialLocale={options.locale}>{ui}</LocaleProvider>
      ) : (
        ui
      )}
    </RefreshProvider>,
  );
}

describe("PaperlessAttachmentStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getPaperlessStatus.mockResolvedValue({
      configured: true,
      documentUiBaseUrl: "https://paperless.example/archive",
    });
  });

  it("keeps Machbar preview/download as the primary attachment behavior", async () => {
    const { container } = renderStrip(
      <PaperlessAttachmentStrip
        attachments={[
          { id: 4711, label: "photo.jpg", kind: "image" },
          { id: 4712, label: "receipt.pdf", kind: "document" },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "photo.jpg" })).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/4711/preview",
    );
    expect(screen.getByRole("link", { name: "photo.jpg" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/integrations/paperless/documents/4711/thumbnail",
    );
    expect(screen.getByRole("link", { name: "receipt.pdf" })).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/4712/download",
    );
    expect(screen.getByRole("link", { name: "receipt.pdf" })).not.toHaveAttribute(
      "target",
    );
    await screen.findByRole("link", {
      name: "photo.jpg in Paperless öffnen",
    });
  });

  it("adds safe direct Paperless links without exposing credentials", async () => {
    renderStrip(
      <PaperlessAttachmentStrip
        attachments={[{ id: 4712, label: "receipt.pdf", kind: "document" }]}
      />,
    );

    const directLink = await screen.findByRole("link", {
      name: "receipt.pdf in Paperless öffnen",
    });
    expect(directLink).toHaveAttribute(
      "href",
      "https://paperless.example/archive/documents/4712/details",
    );
    expect(directLink).toHaveAttribute("target", "_blank");
    expect(directLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(directLink.getAttribute("href")).not.toContain("token");
  });

  it("hides the direct Paperless link when the UI base URL is unavailable", async () => {
    mockedApi.getPaperlessStatus.mockResolvedValueOnce({
      configured: false,
      documentUiBaseUrl: null,
    });

    renderStrip(
      <PaperlessAttachmentStrip
        attachments={[{ id: 4712, label: "receipt.pdf", kind: "document" }]}
      />,
    );

    await waitFor(() => expect(mockedApi.getPaperlessStatus).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: /Paperless öffnen/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "receipt.pdf" })).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/4712/download",
    );
  });

  it("uses English labels in the English locale", async () => {
    renderStrip(
      <PaperlessAttachmentStrip
        attachments={[{ id: 7, label: "manual.pdf", kind: "document" }]}
      />,
      { locale: "en" },
    );

    expect(
      await screen.findByRole("link", {
        name: "Open manual.pdf in Paperless",
      }),
    ).toHaveTextContent("Open in Paperless");
  });
});
