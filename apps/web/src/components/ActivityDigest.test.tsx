import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDigest } from "@machbar/shared";
import { LocaleProvider } from "../lib/locale";
import { RefreshProvider } from "../lib/refresh";
import { api } from "../lib/api";
import { ActivityDigest as ActivityDigestComponent } from "./ActivityDigest";

vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMemberId: 1 }),
  useOptionalIdentity: () => ({ currentMemberId: 1 }),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getActivityDigest: vi.fn(),
      acknowledgeActivityDigest: vi.fn(),
    },
  };
});

const mockedGetDigest = vi.mocked(api.getActivityDigest);
const mockedAck = vi.mocked(api.acknowledgeActivityDigest);

function digest(entries: ActivityDigest["entries"]): ActivityDigest {
  return {
    acknowledgedThroughEventId: 2,
    throughEventId: 4,
    entries,
    totalEntryCount: entries.length,
    hiddenEntryCount: 0,
  };
}

function entry(index: number): ActivityDigest["entries"][number] {
  return {
    key: `entry-${index}`,
    category: "progress",
    priority: 3,
    kind: "task_completed",
    params: { title: `Aufgabe ${index}` },
    actor: { id: 2, name: "Sarah", color: "#fff", pictureUrl: null },
    project: null,
    primary: { type: "task", id: index, title: `Aufgabe ${index}` },
    related: [],
    eventIds: [index],
    latestEventAt: "2026-10-08T08:00:00.000Z",
  };
}

function renderDigest() {
  return render(
    <LocaleProvider initialLocale="de">
      <MemoryRouter>
        <RefreshProvider>
          <ActivityDigestComponent />
        </RefreshProvider>
      </MemoryRouter>
    </LocaleProvider>,
  );
}

describe("ActivityDigest", () => {
  beforeEach(() => {
    mockedGetDigest.mockReset();
    mockedAck.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when there are no meaningful entries", async () => {
    mockedGetDigest.mockResolvedValue(digest([]));
    const { container } = renderDigest();
    await waitFor(() => expect(mockedGetDigest).toHaveBeenCalled());
    expect(container.querySelector(".activity-digest")).toBeNull();
  });

  it("shows five entries and expands the remaining curated entries", async () => {
    mockedGetDigest.mockResolvedValue(digest(Array.from({ length: 6 }, (_, i) => entry(i + 1))));
    renderDigest();
    expect(await screen.findByText("Seit deinem letzten Besuch")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "Weitere Änderungen anzeigen" }));
    expect(screen.getAllByRole("link")).toHaveLength(6);
  });

  it("acknowledges only through the returned snapshot and retains the card on failure", async () => {
    mockedGetDigest.mockResolvedValue(digest([entry(1)]));
    mockedAck.mockRejectedValue(new Error("offline"));
    renderDigest();
    await screen.findByText("Seit deinem letzten Besuch");
    await userEvent.click(screen.getByRole("button", { name: "Als gelesen markieren" }));
    expect(mockedAck).toHaveBeenCalledWith(4, 1);
    expect(await screen.findByText("Änderungen konnten nicht als gelesen markiert werden.")).toBeInTheDocument();
    expect(screen.getByText("Seit deinem letzten Besuch")).toBeInTheDocument();
  });
});
