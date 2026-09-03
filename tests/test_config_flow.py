"""Tests for the Machbar config flow."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.machbar.client import (
    CannotConnect,
    InvalidPairing,
    UnsupportedVersion,
)
from custom_components.machbar.const import DOMAIN


@pytest.fixture(autouse=True)
def mock_managed_session():
    """Avoid creating aiohttp worker threads when the client call is mocked."""
    with patch(
        "custom_components.machbar.config_flow.async_get_clientsession",
        return_value=object(),
    ):
        yield


@pytest.mark.parametrize(
    ("side_effect", "expected_error"),
    [
        (CannotConnect(), "cannot_connect"),
        (InvalidPairing(), "invalid_pairing"),
        (UnsupportedVersion(), "unsupported_version"),
    ],
)
async def test_config_flow_errors(hass, side_effect, expected_error):
    """Connection, pairing, and version errors are actionable."""
    with patch(
        "custom_components.machbar.config_flow.MachbarClient.pair",
        AsyncMock(side_effect=side_effect),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_USER},
            data={"origin": "https://machbar.example", "pairing_code": "123456"},
        )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": expected_error}


async def test_config_flow_rejects_bad_origin(hass):
    """Only origin URLs are accepted."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
        data={
            "origin": "https://user:pass@machbar.example/a?secret=yes",
            "pairing_code": "123456",
        },
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_url"}


async def test_config_flow_persists_credentials(hass):
    """Pairing stores all credentials required by later snapshots."""
    pair = AsyncMock(
        return_value={
            "token": "secret-token",
            "instanceId": "instance-1",
            "protocolVersion": 1,
        }
    )
    with (
        patch("custom_components.machbar.config_flow.MachbarClient.pair", pair),
        patch(
            "custom_components.machbar.async_setup_entry",
            AsyncMock(return_value=True),
        ),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_USER},
            data={
                "origin": "https://machbar.example/",
                "pairing_code": "123456",
            },
        )
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {
        "origin": "https://machbar.example",
        "token": "secret-token",
        "instanceId": "instance-1",
        "protocolVersion": 1,
    }
    pair.assert_awaited_once_with("123456")
