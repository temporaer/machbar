import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { IdentityProvider } from "../lib/identity";
import { SearchFilterBar } from "./SearchFilterBar";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTag } from "../test/fixtures";
import type { SearchFilters } from "@machbar/shared";
import { useState } from "react";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function Harness() {
  const [filters, setFilters] = useState<SearchFilters>({});
  return (
    <SearchFilterBar
      filters={filters}
      onChange={setFilters}
      projects={[makeProject({ id: 1, title: "Umzug" })]}
      tags={[makeTag({ id: 2, name: "eilig" })]}
    />
  );
}

describe("SearchFilterBar", () => {
  it("erlaubt Textsuche und das Setzen von Filtern", async () => {
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    render(
      <MemoryRouter>
        <IdentityProvider>
          <Harness />
        </IdentityProvider>
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText("Suchen"), "Kisten");
    expect(screen.getByLabelText("Suchen")).toHaveValue("Kisten");

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(await screen.findByText("Umzug")).toBeInTheDocument();
    expect(screen.getByText("eilig")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(screen.getByLabelText("Suchen")).toHaveValue("");
  });
});
