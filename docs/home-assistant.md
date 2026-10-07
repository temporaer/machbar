# Home Assistant

Machbar ships a Home Assistant custom integration. Machbar remains a standalone
service; the integration sends zone and `person.*` state to it and never
exposes the Machbar UI through Home Assistant. It also provides the narrow,
bidirectional bridge used by **Verarbeiten**: Machbar leases
`intake_analyze`, `cleanup_round_analyze`, and `calendar_create` requests,
and the Home Assistant worker
executes them using the entities configured locally in Home Assistant.

## Install with HACS

1. Open **HACS → Custom repositories**.
2. Add `https://github.com/temporaer/machbar` with category **Integration**.
3. Return to HACS and open **Machbar**.
4. Press **Download** / **Install**, then restart Home Assistant when prompted.
5. Open **Settings → Devices & services → Add integration → Machbar**.
6. Complete the pairing flow below.

The integration requires Home Assistant **2025.8.0 or newer**. Machbar and
the bundled component speak protocol **2** and must be upgraded together;
there is no v1 compatibility mode. After an upgrade, reopen the integration's
options flow and save the entity selections again if the intake card reports
an outdated protocol or missing configuration.

Adding the custom repository only makes Machbar discoverable in HACS; it does
not install the integration. Until tagged releases are published, HACS installs
the development version from the default branch.

## Pair

1. In Machbar, open **More → Home Assistant** and start pairing.
2. In Home Assistant, add the **Machbar** integration.
3. Enter Machbar's HTTP(S) origin and the one-time pairing code.
4. Back in Machbar, map each synchronized Home Assistant person to a household
   member.

The code expires after about ten minutes and can be used once. Re-pairing
rotates the integration token; disconnecting revokes it immediately.

## Configure Verarbeiten

Open **Settings → Devices & services → Machbar → Configure** and select:

- an `ai_task.*` entity with the **Generate data** feature; for photos and
  PDFs, the entity must also support AI Task attachments. `.txt` uploads are
  decoded as UTF-8 and appended to the source text rather than sent as
  attachments (invalid UTF-8 is rejected);
- a writable `calendar.*` entity with the **Create event** feature.

The AI Task entity is required; Verarbeiten does not use
`conversation.process`, select a model, or accept model-chosen entity IDs.
Home Assistant and the selected provider remain authoritative for AI execution
and calendar objects. Machbar stores no AI-provider credentials, OpenAI key,
Google credentials, or Home Assistant access token.

The same AI Task entity also powers the **Klärungsrunde** (More →
Klärungsrunde): Machbar sends a few sampled work items with coaching
instructions, and the worker returns structured, advisory results through the
`CLEANUP_ROUND_STRUCTURE` schema. That schema enforces only the response
envelope (vocabularies are described, not closed enums, and unknown result keys
are dropped); Machbar validates every entry and keeps the valid ones. Update the custom component together with
Machbar; an older component reports the new request kind as unsupported.

The worker long-polls Machbar, executes only the three fixed request kinds, and
posts the result with its lease token. Machbar can retry expired leases and
bounded transient failures; this is not an arbitrary Home Assistant RPC
channel. Home Assistant must be online while an intake is analyzed or while a
reviewed calendar event is being created.

## Data and behavior

Home Assistant sends complete snapshots of zone names and person-to-zone
presence. Coordinates are never sent. Machbar uses this transient state only
to filter Today and populate the context section in Waiting.

Context requirements do not change blockers, executability, dependencies,
project activation readiness, canonical next actions, or stuck diagnosis.
Disconnected, unmapped, unknown, inactive, and data older than 30 minutes all
fail open.

Verarbeiten is an intake/clarification adapter rather than a calendar system or
AI assistant. The review page remains the human decision point. Calendar
events are created with a `machbar-ref:<correlation-id>` marker so retries are
idempotent; Machbar records the recovered UID as provenance for related work
items, but does not perform calendar lifecycle synchronization.
