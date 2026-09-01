import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
  },
  paperlessDocumentThumbnailUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/thumbnail`,
}));

const mockedApi = vi.mocked(api, true);

describe("TaskRow attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:swipe-coach-seen", "true");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("shows one lazy subdued preview, an overflow count, and authored notes only", async () => {
    const { container } = renderWithProviders(
      <TaskOutline
        tasks={[
          makeTask({
            id: 12,
            title: "Belege ablegen",
            notes:
              "Wichtig\n\n![receipt](paperless:41)\n\n[manual.pdf](paperless:42)",
          }),
        ]}
        emptyMessage="Leer"
      />,
    );
    await screen.findByText("Belege ablegen");

    const preview = container.querySelector(".task-row-attachment-preview");
    const image = preview?.querySelector("img");
    expect(preview).toHaveAccessibleName("2 Anhänge");
    expect(image).toHaveAttribute(
      "src",
      "/api/integrations/paperless/documents/41/thumbnail",
    );
    expect(image).toHaveAttribute("loading", "lazy");
    expect(preview).toHaveTextContent("+1");
    expect(screen.getByText("Wichtig")).toBeInTheDocument();
    expect(screen.queryByText("manual.pdf")).not.toBeInTheDocument();

    fireEvent.error(image!);
    expect(container.querySelector(".task-row-attachment-preview")).toBeNull();
    expect(screen.getByRole("button", { name: "Belege ablegen" })).toBeEnabled();
  });
});
