import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { de as strings } from "../i18n/de";
import { makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { MoveProjectSheet } from "./MoveProjectSheet";
import { ProjectConvertToTaskSheet } from "./ProjectConvertToTaskSheet";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn(), getProjects: vi.fn(), getProject: vi.fn(), getTask: vi.fn(),
  previewTaskConversion: vi.fn(), convertTaskToStory: vi.fn(), convertStoryToTask: vi.fn(), moveProject: vi.fn(),
} }));
const mockedApi = vi.mocked(api);

describe("retired workflow success invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.previewTaskConversion.mockResolvedValue({ decision: null, activatingProjects: [] });
  });

  it.each(["task conversion", "project conversion", "project move"] as const)(
    "refreshes the captured read after %s retires without resuming its UI",
    async operation => {
      const task = makeTask({ id: 42 });
      const source = { ...makeProject({ id: 42 }), tasks: [], hierarchyRevisions: [{ id: 42, revision: 1 }] };
      const destination = { ...makeProject({ id: 43, title: "Destination" }), tasks: [] };
      let stored = operation === "task conversion" ? [] : [source, destination];
      const next = operation === "task conversion" ? [source]
        : operation === "project conversion" ? [destination]
        : [{ ...source, parentId: destination.id }, destination];
      mockedApi.getProjects.mockImplementation(async () => stored);
      mockedApi.getProject.mockImplementation(async id => id === source.id ? source : destination);
      mockedApi.getTask.mockResolvedValue(task);
      let complete!: () => void;
      const pending = new Promise<void>(resolve => { complete = () => { stored = next; resolve(); }; });
      mockedApi.convertTaskToStory.mockImplementation(async () => { await pending; return source; });
      mockedApi.convertStoryToTask.mockImplementation(async () => { await pending; return task; });
      mockedApi.moveProject.mockImplementation(async () => { await pending; return source; });
      const onClose = vi.fn();
      function Parent() {
        const [open, setOpen] = useState(true);
        const current = useRef(true);
        const { data } = useAsync(() => api.getProjects());
        return <>
          <output data-testid="projects-read">{JSON.stringify(data?.map(({ id, parentId }) => ({ id, parentId })))}</output>
          <button onClick={() => { current.current = false; setOpen(false); }}>Close workflow</button>
          {open ? operation === "task conversion"
            ? <TaskConvertToProjectSheet task={task} onClose={onClose} isCurrent={() => current.current} />
            : operation === "project conversion"
              ? <ProjectConvertToTaskSheet story={source} onClose={onClose} isCurrent={() => current.current} />
              : <MoveProjectSheet story={source} onClose={onClose} isCurrent={() => current.current} />
            : null}
        </>;
      }
      const projection = (projects: typeof stored) => JSON.stringify(projects.map(({ id, parentId }) => ({ id, parentId })));
      renderWithProviders(<Parent />);
      await waitFor(() => expect(screen.getByTestId("projects-read")).toHaveTextContent(projection(stored)));
      if (operation === "project move") {
        await userEvent.click(await screen.findByRole("button", { name: destination.title }));
        const save = screen.getByRole("button", { name: strings.moveHere });
        await waitFor(() => expect(save).toBeEnabled());
        await userEvent.click(save);
      } else {
        const save = await screen.findByRole("button", { name: operation === "task conversion" ? strings.convertToProjectBacklog : strings.convertProjectToTask });
        await waitFor(() => expect(save).toBeEnabled());
        await userEvent.click(save);
      }
      const mutation = operation === "task conversion" ? mockedApi.convertTaskToStory
        : operation === "project conversion" ? mockedApi.convertStoryToTask : mockedApi.moveProject;
      await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "Close workflow", hidden: true }));
      const reads = mockedApi.getProjects.mock.calls.length;
      await act(async () => { complete(); });
      await waitFor(() => expect(screen.getByTestId("projects-read")).toHaveTextContent(projection(next)));
      expect(mockedApi.getProjects).toHaveBeenCalledTimes(reads + 1);
      expect(onClose).not.toHaveBeenCalled();
    },
  );
});
