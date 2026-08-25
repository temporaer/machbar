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
  });

  it("serializes the given memberId as a query param", async () => {
    const fetchMock = mockFetchOnce({
      text: async () => JSON.stringify({ planned: [], overdue: [], dueToday: [], dueSoon: [], shared: [] }),
    });
    await api.getAgenda(7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agenda/today?memberId=7");
  });

  it("omits the memberId query param when called with null or no argument", async () => {
    const fetchMock = mockFetchOnce({
      text: async () => JSON.stringify({ planned: [], overdue: [], dueToday: [], dueSoon: [], shared: [] }),
    });
    await api.getAgenda(null);
    await api.getAgenda();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/agenda/today");
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("/api/agenda/today");
  });
});
