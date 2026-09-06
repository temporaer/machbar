"""HTTP client for the Machbar physical-context API."""

from __future__ import annotations

from typing import Any

from aiohttp import ClientError, ClientResponse, ClientSession, ClientTimeout

from .const import CONTEXT_PATH, PAIR_PATH, PROTOCOL_VERSION


class MachbarError(Exception):
    """Base Machbar client error."""


class CannotConnect(MachbarError):
    """Machbar could not be reached."""


class InvalidAuth(MachbarError):
    """Credentials were rejected."""


class InvalidPairing(MachbarError):
    """The pairing code was rejected."""


class UnsupportedVersion(MachbarError):
    """The peer does not support this protocol version."""


class InvalidResponse(MachbarError):
    """Machbar returned an invalid response."""


class MachbarClient:
    """Small async client using Home Assistant's managed session."""

    def __init__(
        self, session: ClientSession, origin: str, token: str | None = None
    ) -> None:
        self._session = session
        self._origin = origin.rstrip("/")
        self._token = token

    async def pair(self, pairing_code: str) -> dict[str, Any]:
        """Exchange a short-lived pairing code for integration credentials."""
        response = await self._post(
            PAIR_PATH,
            {"pairingCode": pairing_code, "protocolVersion": PROTOCOL_VERSION},
            authenticated=False,
        )
        data = await self._json(response)
        version = data.get("protocolVersion")
        if version != PROTOCOL_VERSION:
            raise UnsupportedVersion
        if not all(isinstance(data.get(key), str) and data[key] for key in ("token", "instanceId")):
            raise InvalidResponse
        return data

    async def push_snapshot(self, snapshot: dict[str, Any]) -> None:
        """Post a complete physical-context snapshot."""
        await self._post(CONTEXT_PATH, snapshot, authenticated=True)

    async def _post(
        self, path: str, payload: dict[str, Any], *, authenticated: bool
    ) -> ClientResponse:
        headers: dict[str, str] = {}
        if authenticated:
            if not self._token:
                raise InvalidAuth
            headers["Authorization"] = f"Bearer {self._token}"
        try:
            response = await self._session.post(
                f"{self._origin}{path}",
                json=payload,
                headers=headers,
                timeout=ClientTimeout(total=10),
            )
        except (ClientError, TimeoutError) as err:
            raise CannotConnect from err

        if response.status in (401, 403):
            response.release()
            if authenticated:
                raise InvalidAuth
            raise InvalidPairing
        if response.status == 426:
            response.release()
            raise UnsupportedVersion
        if response.status == 400 and not authenticated:
            error_code = await self._error_code(response)
            if error_code == "unsupported_protocol_version":
                raise UnsupportedVersion
            raise InvalidPairing
        if response.status >= 400:
            response.release()
            raise CannotConnect
        return response

    @staticmethod
    async def _json(response: ClientResponse) -> dict[str, Any]:
        try:
            data = await response.json()
        except (ValueError, ClientError) as err:
            raise InvalidResponse from err
        if not isinstance(data, dict):
            raise InvalidResponse
        return data

    @staticmethod
    async def _error_code(response: ClientResponse) -> str | None:
        try:
            data = await response.json()
        except (ValueError, ClientError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("error"), dict):
            return None
        code = data["error"].get("code")
        return code if isinstance(code, str) else None
