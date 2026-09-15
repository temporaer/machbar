# Copilot / MCP

Machbar exposes a remote
[Model Context Protocol](https://modelcontextprotocol.io/) endpoint at
`/api/mcp`. It uses the official TypeScript MCP SDK and runs inside the
existing API process; no second service is required.

## Connect

1. Sign in to Machbar through Pocket ID.
2. Open **More → Administration → Copilot / MCP**.
3. Give the client a recognizable name.
4. Select its permanent scope:
   - **Work** exposes only work-scoped tasks and projects belonging to the
     authenticated member.
   - **Household** exposes only household-scoped tasks and projects.
5. Create the token and copy it immediately. Machbar stores only its SHA-256
   hash and cannot show it again.
6. Open `/mcp` in Copilot CLI and add a remote HTTP server using the displayed
   endpoint. Configure the displayed token as an `Authorization: Bearer`
   header.

The scope is part of the credential and cannot be changed per tool call.
Create a separate named agent when another scope is needed.

## Tools

Read tools cover Today, Review, Waiting, search, task details, project details,
and project lists. Write tools cover task creation, completion, atomic metadata
updates, hierarchy moves, resolving external waits, and legal project lifecycle
commands.

MCP tools call the same domain commands and projections as the ordinary API.
They therefore enforce the same hierarchy rules, project readiness checks,
calendar-date semantics, and optimistic concurrency revisions.

## Security and revocation

An agent token authorizes reads and writes as the member who created it, within
its fixed scope. Treat it like a password and send it only over HTTPS.

The token is shown once. Losing it requires creating a replacement. Revoke an
agent from the same settings page; revocation takes effect on its next request.
Each client should have its own named token so it can be revoked independently.
