import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkItemDetailDisclosure } from "./WorkItemDetailSection";

describe("WorkItemDetailDisclosure heading actions", () => {
  it("keeps actions reachable while collapsed without nesting them in the disclosure toggle", async () => {
    const edit = vi.fn();
    render(
      <WorkItemDetailDisclosure title="Outcome" actions={<button onClick={edit}>Edit outcome</button>}>
        <p>Saved criterion</p>
      </WorkItemDetailDisclosure>,
    );
    const details = screen.getByRole("heading", { name: "Outcome" }).closest("details")!;
    const action = screen.getByRole("button", { name: "Edit outcome" });
    expect(action).toBeVisible();
    expect(action.closest("summary")).toBeNull();
    expect(screen.getByText("Saved criterion")).not.toBeVisible();
    action.focus();
    await userEvent.keyboard("{Enter}");
    expect(edit).toHaveBeenCalledOnce();
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("Saved criterion")).toBeVisible();
  });

  it("preserves open/reset/forced-focus behavior and leaves disclosure navigation enabled during writes", async () => {
    const view = (resetKey: number, forceOpen = false) => (
      <fieldset disabled>
        <WorkItemDetailDisclosure title="Structure" resetKey={resetKey} forceOpen={forceOpen}
          actions={<button>Edit structure</button>}>
          <p>Existing work</p>
        </WorkItemDetailDisclosure>
      </fieldset>
    );
    const { rerender } = render(view(1));
    const summary = screen.getByText("Structure").closest("summary")!;
    expect(screen.getByRole("button", { name: "Edit structure" })).toBeDisabled();
    fireEvent.click(summary);
    fireEvent(summary.closest("details")!, new Event("toggle"));
    expect(screen.getByText("Existing work")).toBeVisible();
    rerender(view(2));
    expect(screen.getByText("Existing work")).not.toBeVisible();
    rerender(view(2, true));
    expect(screen.getByText("Existing work")).toBeVisible();
  });
});
