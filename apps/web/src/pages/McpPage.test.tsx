import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { McpPage } from "./McpPage";

const { createMcpAgent, listMcpAgents } = vi.hoisted(() => ({
  createMcpAgent: vi.fn(),
  listMcpAgents: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([
      { id: 1, name: "Mira", color: "#123456", pictureUrl: null },
    ]),
    listMcpAgents,
    createMcpAgent,
    revokeMcpAgent: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("McpPage", () => {
  beforeEach(() => {
    listMcpAgents.mockResolvedValue([]);
    createMcpAgent.mockResolvedValue({
      agent: {
        id: 1,
        name: "Copilot",
        memberId: 1,
        scope: "work",
        createdAt: "2026-09-15T08:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
      token: "mbmcp_secret",
      endpoint: "/api/mcp",
    });
  });

  it("creates a token with the selected immutable scope and shows it once", async () => {
    renderWithProviders(<McpPage />);

    await screen.findByText("Noch keine MCP-Agents verbunden.");
    await userEvent.click(screen.getByRole("button", { name: "Token erstellen" }));

    expect(createMcpAgent).toHaveBeenCalledWith("Copilot", "work");
    expect(await screen.findByDisplayValue("mbmcp_secret")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://localhost:3000/api/mcp"))
      .toBeInTheDocument();
  });
});
