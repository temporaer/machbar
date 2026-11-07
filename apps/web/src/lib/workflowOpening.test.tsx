import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { TaskWorkflowProvider, useTaskWorkflow } from "./taskWorkflowContext";
import { ProjectWorkflowProvider, useProjectWorkflow } from "./projectWorkflowContext";

describe("workflow opening ownership", () => {
  it("does not let an old task close replace a new same-target opening before React renders", () => {
    const { result } = renderHook(useTaskWorkflow, {
      wrapper: ({ children }: { children: ReactNode }) => <TaskWorkflowProvider>{children}</TaskWorkflowProvider>,
    });
    act(() => result.current.open("plan", 1));
    const previous = result.current.current;
    if (!previous) throw new Error("Missing task opening");
    act(() => {
      result.current.open("plan", 1);
      expect(result.current.isCurrent(previous)).toBe(false);
      result.current.close(previous);
    });
    expect(result.current.current).toMatchObject({ kind: "plan", taskId: 1 });
    expect(result.current.current).not.toBe(previous);
  });

  it("does not let an old project close replace a new same-target opening before React renders", () => {
    const { result } = renderHook(useProjectWorkflow, {
      wrapper: ({ children }: { children: ReactNode }) => <ProjectWorkflowProvider>{children}</ProjectWorkflowProvider>,
    });
    act(() => result.current.open("assignDriver", 1));
    const previous = result.current.current;
    if (!previous) throw new Error("Missing project opening");
    act(() => {
      result.current.open("assignDriver", 1);
      expect(result.current.isCurrent(previous)).toBe(false);
      result.current.close(previous);
    });
    expect(result.current.current).toMatchObject({ kind: "assignDriver", projectId: 1 });
    expect(result.current.current).not.toBe(previous);
  });
});
