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

## Home Assistant with Pocket ID OAuth

Machbar can accept a delegated Pocket ID access token for the existing
`/api/mcp` endpoint. Enable it with:

```dotenv
MCP_OAUTH_ENABLED=true
```

This reuses Machbar's existing `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, and `OIDC_PUBLIC_URL` configuration. The OAuth resource
is derived exactly as `${OIDC_PUBLIC_URL}/api/mcp`; no second issuer or MCP
audience setting is supported.

### Pocket ID setup

1. Create a Pocket ID API named **Machbar MCP** with resource
   `https://<machbar-origin>/api/mcp` (no trailing slash).
2. Add the API permission `machbar:mcp:household`, named **Access household
   tasks in Machbar**, with the description **Read and modify
   household-scoped Machbar tasks and projects through MCP.**
3. Create a separate confidential authorization-code OIDC client named
   **Home Assistant – Machbar MCP**. Do not reuse Machbar's browser-login
   client.
4. For a normal My Home Assistant installation, add the redirect URI
   `https://my.home-assistant.io/redirect/oauth`.
5. Enable authorization-code and refresh-token grants, and leave PKCE disabled
   for this client while Home Assistant's MCP flow does not send PKCE.
6. Grant the client user-delegated access to **Machbar MCP** and enable
   `machbar:mcp:household`. Do not enable client/M2M access.

### Home Assistant setup

1. Add the **Model Context Protocol** integration.
2. Set the server URL to `https://<machbar-origin>/api/mcp`.
3. Enter the dedicated Pocket ID client ID and secret when Home Assistant asks
   for Application Credentials.
4. Complete the Pocket ID login and consent flow.
5. Ensure the Pocket ID user has signed into Machbar normally at least once so
   the issuer/subject identity is already linked to a Machbar member.

Home Assistant must reach Machbar over the local network or VPN. The cloud
conversation model does not need direct access. Home Assistant exchanges and
refreshes tokens directly with Pocket ID; Machbar only validates the resulting
access token and never receives the Home Assistant client secret or refresh
token.

OAuth access is household-only. Existing named agent tokens remain the
preferred option for scripts, developer CLIs, and work-scoped access.

## Tools

Read tools cover Today, member lookup, Review, Waiting, search, task details,
project details, and project lists. Write tools cover task creation, completion,
atomic metadata updates, reminder management, hierarchy moves, resolving
external waits, and legal project lifecycle commands. Task cancellation is
available for reconciliations where tracked work was explicitly abandoned rather
than completed.

MCP tools call the same domain commands and projections as the ordinary API.
They therefore enforce the same hierarchy rules, project readiness checks,
calendar-date semantics, and optimistic concurrency revisions.

Household MCP does not identify the person speaking through Home Assistant. An
omitted task owner is explicitly shared/unassigned; use `machbar_list_members`
to resolve a stable member ID when ownership is clear. Dates are calendar dates
in `YYYY-MM-DD` format only. MCP reminder inputs accept absolute reminder times
as full RFC3339/ISO instants only; deadline-relative reminders remain available
to Machbar's internal/UI APIs but are not created or edited through MCP.

## Security and revocation

An agent token authorizes reads and writes as the member who created it, within
its fixed scope. Treat it like a password and send it only over HTTPS.

The token is shown once. Losing it requires creating a replacement. Revoke an
agent from the same settings page; revocation takes effect on its next request.
Each client should have its own named token so it can be revoked independently.

## Local pull-request reconciler

`npm run pr:track -- sync` reconciles configured GitHub repositories into a
work-scoped task hierarchy. It discovers open PRs authored by the configured
`gh` identity, excludes Dependabot, creates missing tasks, completes merged
PRs, and cancels PRs closed without merge. It reads the existing `machbar` MCP
endpoint and token from Copilot CLI configuration; no second Machbar token is
stored.

`trackOpenedAfter` provides a bootstrap cutoff: automatic discovery considers
only self-authored PRs created at or after that timestamp. Older PRs can still
be included explicitly with `add`.

Explicit exceptions and repositories use the same CLI:

```bash
npm run pr:track -- add https://github.com/owner/repo/pull/123
npm run pr:track -- remove https://github.com/owner/repo/pull/123
npm run pr:track -- repo add ~/r/repo --account github-user
npm run pr:track -- repo remove owner/repo
npm run pr:track -- list
```

The default configuration is
`~/.config/machbar/pr-tracker.json`. Repository entries record a local path,
GitHub `owner/repo`, and the `gh` account used for API calls. Adding a
repository verifies that the chosen account can access it before saving.
