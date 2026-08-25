import { afterEach, describe, expect, it, vi } from "vitest";
import { api, request } from "./api";

function mockFetchOnce(response: Partial<Response> & { body?: unknown } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 204,
    statusText: "No Content",
    text: async () => "",
    json: async () => ({}),
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return { ...(init?.headers as Record<string, string> | undefined) };
}

describe("api request() Content-Type handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits Content-Type for a bodyless deleteMember request", async () => {
    const fetchMock = mockFetchOnce();
    await api.deleteMember(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/members/1");
    expect(init.method).toBe("DELETE");
    expect(headersOf(fetchMock)).not.toHaveProperty("Content-Type");
  });

  it("omits Content-Type for a bodyless deleteTask request", async () => {
    const fetchMock = mockFetchOnce();
    await api.deleteTask(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/1");
    expect(init.method).toBe("DELETE");
    expect(headersOf(fetchMock)).not.toHaveProperty("Content-Type");
  });

  it("still sends Content-Type: application/json for requests with a JSON body", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 1, name: "Lea" }),
    });
    await api.createMember({ name: "Lea" });

    expect(headersOf(fetchMock)).toMatchObject({ "Content-Type": "application/json" });
  });

  it("lets an explicitly supplied header override the default (including for bodyless requests)", async () => {
    const fetchMock = mockFetchOnce();
    await request("/tasks/1", { method: "DELETE", headers: { "Content-Type": "text/plain" } });

    expect(headersOf(fetchMock)).toMatchObject({ "Content-Type": "text/plain" });
  });

  it("does not add a default header at all when the caller supplies unrelated headers on a bodyless request", async () => {
    const fetchMock = mockFetchOnce();
    await request("/tasks/1", { method: "DELETE", headers: { "X-Test": "1" } });

    const headers = headersOf(fetchMock);
    expect(headers).not.toHaveProperty("Content-Type");
    expect(headers).toMatchObject({ "X-Test": "1" });
  });
});

describe("api.getAgenda memberId scoping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("serializes the given memberId and browser-local date as query params", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 2, 0, 30));
    const fetchMock = mockFetchOnce({
      text: async () => JSON.stringify({ planned: [], overdue: [], dueToday: [], dueSoon: [], shared: [] }),
    });
    await api.getAgenda(7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agenda/today?memberId=7&date=2030-01-02");
  });

  it("omits only memberId when called with null or no argument", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 2, 0, 30));
    const fetchMock = mockFetchOnce({
      text: async () => JSON.stringify({ planned: [], overdue: [], dueToday: [], dueSoon: [], shared: [] }),
    });
    await api.getAgenda(null);
    await api.getAgenda();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/agenda/today?date=2030-01-02");
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("/api/agenda/today?date=2030-01-02");
  });
});

describe("api project workflow/criteria/refinement contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits the explicit workflow transition endpoints (backlog <-> active -> completed, archive)", async () => {
    const fetchMock = mockFetchOnce({ text: async () => JSON.stringify({}) });
    await api.activateProject(1, { ownerMemberId: 2 });
    await api.returnProjectToBacklog(1);
    await api.completeProject(1);
    await api.reopenProject(1);
    await api.archiveProject(1);

    const urls = fetchMock.mock.calls.map((c) => (c as [string, RequestInit])[0]);
    expect(urls).toEqual([
      "/api/projects/1/activate",
      "/api/projects/1/return-to-backlog",
      "/api/projects/1/complete",
      "/api/projects/1/reopen",
      "/api/projects/1/archive",
    ]);
    const activateInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(activateInit.method).toBe("POST");
    expect(activateInit.body).toBe(JSON.stringify({ ownerMemberId: 2 }));
  });

  it("hits the ordered acceptance-criteria endpoints", async () => {
    const fetchMock = mockFetchOnce({ text: async () => JSON.stringify({}) });
    await api.addCriterion(1, "Kisten gepackt");
    await api.updateCriterion(1, 9, "Kisten sind gepackt");
    await api.checkCriterion(1, 9, true);
    await api.reorderCriteria(1, [9, 8]);
    await api.removeCriterion(1, 9);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/projects/1/criteria", "POST"],
      ["/api/projects/1/criteria/9", "PATCH"],
      ["/api/projects/1/criteria/9/check", "POST"],
      ["/api/projects/1/criteria/reorder", "POST"],
      ["/api/projects/1/criteria/9", "DELETE"],
    ]);
    expect(calls[3]?.[1].body).toBe(JSON.stringify({ orderedCriterionIds: [9, 8] }));
  });

  it("serializes refinement filters (owner id, the 'none' literal, and project id)", async () => {
    const fetchMock = mockFetchOnce({ text: async () => JSON.stringify([]) });
    await api.getRefinementOwners({ ownerId: 3 });
    await api.getRefinementOwners({ ownerId: "none" });
    await api.getRefinementTasks({ projectId: 5 });
    await api.getRefinementTasks();

    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls).toEqual([
      "/api/refinement/owners?ownerId=3",
      "/api/refinement/owners?ownerId=none",
      "/api/refinement/tasks?projectId=5",
      "/api/refinement/tasks",
    ]);
  });
});
