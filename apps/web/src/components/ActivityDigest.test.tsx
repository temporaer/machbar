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

function planEntry(
  index: number,
  params: ActivityDigest["entries"][number]["params"],
): ActivityDigest["entries"][number] {
  return {
    key: `plan-${index}`,
    category: "personal",
    priority: 1,
    kind: "plan_changed",
    params: { title: `Aufgabe ${index}`, ...params },
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

  it("renders an availability timestamp without throwing", async () => {
    const timestamp = "2026-10-08T09:00:00.000Z";
    mockedGetDigest.mockResolvedValue(
      digest([
        planEntry(1, {
          date: timestamp,
          dateType: "availability",
          direction: "later",
        }),
      ]),
    );

    renderDigest();

    expect(await screen.findByText(/Aufgabe 1/)).toBeInTheDocument();
    expect(screen.getByText(/„Aufgabe 1“ ist ab/)).toBeInTheDocument();
  });

  it("formats offset timestamps in the local timezone", async () => {
    const timestamp = "2026-10-08T09:00:00+02:00";
    mockedGetDigest.mockResolvedValue(
      digest([
        planEntry(2, {
          date: timestamp,
          dateType: "availability",
          direction: "later",
        }),
      ]),
    );

    renderDigest();

    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "long",
      timeStyle: "short",
    }).format(new Date(timestamp));
    expect(await screen.findByText(`„Aufgabe 2“ ist ab ${expected} verfügbar.`)).toBeInTheDocument();
  });

  it.each([
    ["dueDate", "deadline"],
    ["scheduledDate", "scheduled"],
    ["notBeforeDate", "availability"],
  ])("keeps date-only %s values stable", async (_field, dateType) => {
    const date = "2026-10-08";
    mockedGetDigest.mockResolvedValue(
      digest([
        planEntry(3, {
          date,
          dateType,
          direction: "earlier",
        }),
      ]),
    );

    renderDigest();

    expect(await screen.findByText(/Aufgabe 3/)).toBeInTheDocument();
    expect(screen.getByText(/8\. Oktober 2026|October 8, 2026/)).toBeInTheDocument();
  });

  it.each([undefined, "not-a-timestamp"])(
    "uses a safe availability fallback for %s",
    async (date) => {
      mockedGetDigest.mockResolvedValue(
        digest([
          planEntry(4, {
            ...(date === undefined ? {} : { date }),
            dateType: "availability",
            direction: "earlier",
          }),
        ]),
      );

      renderDigest();

      expect(await screen.findByText("„Aufgabe 4“ kann wieder bearbeitet werden.")).toBeInTheDocument();
    },
  );
});
