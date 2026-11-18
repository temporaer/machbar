import { useLayoutEffect, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  TaskTransitionPresentationProvider,
  useTaskTransitionPresentation,
} from "./taskTransitionPresentationContext";
import type { TaskTransitionOrigin } from "./taskTransitionPresentation";

const task = makeTask({ id: 601, title: "Origin task" });

function OriginProbe({ origins }: { origins: Map<string, TaskTransitionOrigin> }) {
  const presentation = useTaskTransitionPresentation();
  useLayoutEffect(() => {
    const origin = presentation?.origin("source", task);
    if (presentation && origin) origins.set(presentation.viewId, origin);
  }, [presentation, origins]);
  return null;
}

function Harness({ origins }: { origins: Map<string, TaskTransitionOrigin> }) {
  const [identityKey, setIdentityKey] = useState("today:mine:1");
  return (
    <>
      <button onClick={() => setIdentityKey("today:all:1")}>Change selection</button>
      <TaskTransitionPresentationProvider
        identityKey={identityKey}
        projection={{ source: { tasks: [task], readSettled: true, readFailed: false } }}
      >
        <OriginProbe origins={origins} />
      </TaskTransitionPresentationProvider>
    </>
  );
}

describe("task transition presentation owner", () => {
  it("retires the old origin on selection change without replacing surrounding controls", async () => {
    const origins = new Map<string, TaskTransitionOrigin>();
    render(<Harness origins={origins} />);
    await waitFor(() => expect(origins.size).toBe(1));
    const [oldOrigin] = origins.values();
    const control = screen.getByRole("button", { name: "Change selection" });

    await act(async () => control.click());
    await waitFor(() => expect(origins.size).toBe(2));

    expect(screen.getByRole("button", { name: "Change selection" })).toBe(control);
    expect(oldOrigin?.begin("late", task, "complete")).toBe("unavailable");
  });
});
