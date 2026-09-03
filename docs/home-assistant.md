# Home Assistant

Machbar ships a push-only Home Assistant custom integration. Machbar remains a
standalone service; the integration sends zone and `person.*` state to it and
never exposes the Machbar UI through Home Assistant.

## Install with HACS

Add this repository as a custom **Integration** repository in HACS, install
Machbar, and restart Home Assistant. Until tagged releases are published, this
is a development installation.

## Pair

1. In Machbar, open **More → Home Assistant** and start pairing.
2. In Home Assistant, add the **Machbar** integration.
3. Enter Machbar's HTTP(S) origin and the one-time pairing code.
4. Back in Machbar, map each synchronized Home Assistant person to a household
   member.

The code expires after about ten minutes and can be used once. Re-pairing
rotates the integration token; disconnecting revokes it immediately.

## Data and behavior

Home Assistant sends complete snapshots of zone names and person-to-zone
presence. Coordinates are never sent. Machbar uses this transient state only
to filter Today and populate the context section in Waiting.

Context requirements do not change blockers, executability, dependencies,
project activation readiness, canonical next actions, or stuck diagnosis.
Disconnected, unmapped, unknown, inactive, and data older than 30 minutes all
fail open.
