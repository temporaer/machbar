import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { IntakeComposer } from "./IntakeComposer";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({ enabled: false, authenticated: false, member: null }),
    getMembers: vi.fn().mockResolvedValue([]),
    createIntake: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("IntakeComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.createIntake.mockResolvedValue({ id: "intake-1" } as never);
  });

  it("replaces only the seeded file after a crop and retains locally added files in order", async () => {
    const original = new File(["original"], "photo.jpg", { type: "image/jpeg" });
    const cropped = new File(["cropped"], "photo-cropped.jpg", { type: "image/jpeg" });
    const extra = new File(["extra"], "notes.pdf", { type: "application/pdf" });
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <IntakeComposer initialFile={original} onCancel={vi.fn()} />,
    );

    await user.upload(screen.getByLabelText("Datei auswählen"), extra);
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();

    rerender(<IntakeComposer initialFile={cropped} onCancel={vi.fn()} />);
    expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
    expect(screen.getByText("photo-cropped.jpg")).toBeInTheDocument();
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verarbeiten" }));
    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.createIntake.mock.calls[0]?.[0].files).toEqual([cropped, extra]);
  });
});
