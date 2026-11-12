import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useItemMutations } from "./useItemMutations";

const bump = vi.fn();
vi.mock("./refresh", () => ({ useRefresh: () => ({ bump }) }));
vi.mock("./strings", () => ({ useStrings: () => ({}) }));
vi.mock("./errorMessage", () => ({
  localizedErrorMessage: (error: Error) => error.message,
  isReadAccessError: (error: { status?: number }) => [401, 403, 404].includes(error.status ?? 0),
  isStaleWriteConflict: (error: { code?: string }) => error.code === "stale_write_conflict",
}));

describe("server-confirmed item commands", () => {
  it("serializes one item while allowing another, then invalidates on confirmation", async () => {
    bump.mockClear();
    const { result } = renderHook(() => useItemMutations());
    let confirm!: (value: string) => void;
    let first!: Promise<string | undefined>;
    act(() => {
      first = result.current.run({ id: 1, mutate: () => new Promise(resolve => { confirm = resolve; }) });
    });
    const duplicate = vi.fn(async () => "duplicate");
    await act(async () => {
      await result.current.run({ id: 1, mutate: duplicate });
      await result.current.run({ id: 2, mutate: async () => "other" });
    });
    expect(duplicate).not.toHaveBeenCalled();
    expect(result.current.isPending(1)).toBe(true);
    expect(bump).toHaveBeenCalledTimes(1);
    await act(async () => { confirm("confirmed"); expect(await first).toBe("confirmed"); });
    expect(result.current.isPending(1)).toBe(false);
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it("keeps feedback and the duplicate guard through independently delayed read revalidation", async () => {
    let finishRefresh!: () => void;
    bump.mockImplementationOnce(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
    const { result } = renderHook(() => useItemMutations());
    let command!: Promise<string | undefined>;
    await act(async () => {
      command = result.current.run({ id: 1, mutate: async () => "confirmed" });
      await Promise.resolve();
    });
    expect(result.current.isPending(1)).toBe(true);
    const duplicate = vi.fn(async () => "duplicate");
    await act(async () => { await result.current.run({ id: 1, mutate: duplicate }); });
    expect(duplicate).not.toHaveBeenCalled();
    await act(async () => { finishRefresh(); expect(await command).toBe("confirmed"); });
    expect(result.current.isPending(1)).toBe(false);
  });

  it("does not turn a committed write into a failed command when read revalidation fails", async () => {
    bump.mockImplementationOnce(() => Promise.reject(new Error("Read offline")));
    const { result } = renderHook(() => useItemMutations());
    await act(async () => {
      expect(await result.current.run({ id: 1, mutate: async () => "confirmed", throwOnError: true })).toBe("confirmed");
    });
    expect(result.current.errors[1]).toBeUndefined();
    expect(result.current.isPending(1)).toBe(false);
  });

  it("publishes explicit errors and preserves the actual rejection for throwing callers", async () => {
    bump.mockClear();
    const failure = new Error("server rejected");
    const { result } = renderHook(() => useItemMutations());
    await act(async () => {
      await expect(result.current.run({ id: 1, mutate: async () => { throw failure; }, throwOnError: true })).rejects.toBe(failure);
    });
    expect(result.current.errors[1]).toBe("server rejected");
    expect(bump).not.toHaveBeenCalled();
  });

  it("invalidates the captured owner after its consumer closes and still returns confirmed success", async () => {
    bump.mockClear();
    const { result, unmount } = renderHook(() => useItemMutations());
    let confirm!: (value: string) => void;
    let command!: Promise<string | undefined>;
    act(() => { command = result.current.run({ id: 1, mutate: () => new Promise<string>(resolve => { confirm = resolve; }) }); });
    unmount();
    await act(async () => { confirm("confirmed"); expect(await command).toBe("confirmed"); });
    expect(bump).toHaveBeenCalledOnce();
  });

  it("does not invalidate a failed command after its consumer closes and preserves the rejection", async () => {
    bump.mockClear();
    const failure = new Error("Write failed");
    const { result, unmount } = renderHook(() => useItemMutations());
    let reject!: (cause: unknown) => void;
    let command!: Promise<unknown>;
    act(() => { command = result.current.run({ id: 1, mutate: () => new Promise((_resolve, fail) => { reject = fail; }), throwOnError: true }); });
    unmount();
    await act(async () => { reject(failure); await expect(command).rejects.toBe(failure); });
    expect(bump).not.toHaveBeenCalled();
  });

  it.each([{ status: 403 }, { code: "stale_write_conflict" }])("revalidates denied or stale data without replaying the rejected command: %j", async details => {
    bump.mockClear();
    const failure = Object.assign(new Error("Rejected"), details);
    const mutate = vi.fn(async () => { throw failure; });
    const { result } = renderHook(() => useItemMutations());
    await act(async () => {
      await expect(result.current.run({ id: 1, mutate, throwOnError: true })).rejects.toBe(failure);
    });
    expect(mutate).toHaveBeenCalledOnce();
    expect(bump).toHaveBeenCalledOnce();
    expect(result.current.errors[1]).toBe("Rejected");
  });
});
