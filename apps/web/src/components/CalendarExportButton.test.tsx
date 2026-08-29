import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarExportButton } from "./CalendarExportButton";

const item = {
  kind: "task" as const,
  id: 42,
  title: "Elternabend",
  notes: "Raum 3",
  dueDate: "2026-09-15",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CalendarExportButton", () => {
  it("shares an ICS file when browser file sharing is supported", async () => {
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: canShare,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });

    render(<CalendarExportButton item={item} />);
    await userEvent.click(screen.getByRole("button", { name: "In Kalender" }));

    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    const data = share.mock.calls[0]![0];
    expect(data.title).toBe("Elternabend");
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toEqual(
      expect.objectContaining({
        name: "Elternabend.ics",
        type: "text/calendar",
      }),
    );
    expect(canShare).toHaveBeenCalledWith(data);
    expect(screen.getByRole("status")).toHaveTextContent(
      "An Kalender geteilt",
    );
  });

  it("downloads the ICS immediately when file sharing is unavailable", async () => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: vi.fn(),
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:calendar");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<CalendarExportButton item={item} />);
    await userEvent.click(screen.getByRole("button", { name: "In Kalender" }));

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(File));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:calendar");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Kalenderdatei heruntergeladen",
    );
  });

  it("does not render without a due date", () => {
    render(<CalendarExportButton item={{ ...item, dueDate: null }} />);
    expect(
      screen.queryByRole("button", { name: "In Kalender" }),
    ).not.toBeInTheDocument();
  });

  it("treats closing the native share sheet as cancellation", async () => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: vi
        .fn()
        .mockRejectedValue(new DOMException("Cancelled", "AbortError")),
    });

    render(<CalendarExportButton item={item} />);
    await userEvent.click(screen.getByRole("button", { name: "In Kalender" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "In Kalender" })).toBeEnabled(),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
