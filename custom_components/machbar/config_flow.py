"""Config flow for Machbar."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from yarl import URL

from .client import (
    CannotConnect,
    InvalidAuth,
    InvalidPairing,
    InvalidResponse,
    MachbarClient,
    UnsupportedVersion,
)
from .const import (
    CONF_INSTANCE_ID,
    CONF_ORIGIN,
    CONF_PAIRING_CODE,
    CONF_PROTOCOL_VERSION,
    CONF_TOKEN,
    DOMAIN,
)


def normalize_origin(value: str) -> str:
    """Validate and normalize an HTTP origin."""
    try:
        url = URL(value.strip())
    except ValueError as err:
        raise vol.Invalid("invalid URL") from err
    if (
        url.scheme not in ("http", "https")
        or not url.host
        or url.user is not None
        or url.query_string
        or url.fragment
        or url.path not in ("", "/")
    ):
        raise vol.Invalid("URL must be an HTTP origin")
    return str(url.with_path("")).rstrip("/")


class MachbarConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure Machbar through the UI."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Pair a Home Assistant instance with Machbar."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                origin = normalize_origin(user_input[CONF_ORIGIN])
                result = await MachbarClient(
                    async_get_clientsession(self.hass), origin
                ).pair(user_input[CONF_PAIRING_CODE])
            except vol.Invalid:
                errors["base"] = "invalid_url"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except (InvalidAuth, InvalidPairing):
                errors["base"] = "invalid_pairing"
            except UnsupportedVersion:
                errors["base"] = "unsupported_version"
            except InvalidResponse:
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(result[CONF_INSTANCE_ID])
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="Machbar",
                    data={
                        CONF_ORIGIN: origin,
                        CONF_TOKEN: result[CONF_TOKEN],
                        CONF_INSTANCE_ID: result[CONF_INSTANCE_ID],
                        CONF_PROTOCOL_VERSION: result[CONF_PROTOCOL_VERSION],
                    },
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_ORIGIN): str,
                vol.Required(CONF_PAIRING_CODE): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)
