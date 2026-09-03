# Home Assistant

Machbar ships a push-only Home Assistant custom integration. Machbar remains a
standalone service; the integration sends zone and `person.*` state to it and
never exposes the Machbar UI through Home Assistant.

## Install with HACS

1. Open **HACS → Custom repositories**.
2. Add `https://github.com/temporaer/machbar` with category **Integration**.
3. Return to HACS and open **Machbar**.
4. Press **Download** / **Install**, then restart Home Assistant when prompted.
5. Open **Settings → Devices & services → Add integration → Machbar**.
6. Complete the pairing flow below.

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

## Data and behavior

Home Assistant sends complete snapshots of zone names and person-to-zone
presence. Coordinates are never sent. Machbar uses this transient state only
to filter Today and populate the context section in Waiting.

Context requirements do not change blockers, executability, dependencies,
project activation readiness, canonical next actions, or stuck diagnosis.
Disconnected, unmapped, unknown, inactive, and data older than 30 minutes all
fail open.
