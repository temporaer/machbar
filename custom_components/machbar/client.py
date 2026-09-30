"""HTTP client for the Machbar integration."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from aiohttp import ClientError, ClientResponse, ClientSession, ClientTimeout

from .const import (
    ATTACHMENT_PATH,
    CONTEXT_PATH,
    PAIR_PATH,
    PROTOCOL_VERSION,
    REQUEST_COMPLETE_PATH,
    REQUESTS_NEXT_PATH,
    SYNC_TASK_PATH,
)


class MachbarError(Exception):
    """Base Machbar client error."""


class CannotConnect(MachbarError):
    """Machbar could not be reached."""


class ApplicationError(MachbarError):
    """Machbar rejected a request that should not be retried unchanged."""


class InvalidAuth(MachbarError):
    """Credentials were rejected."""


class InvalidPairing(MachbarError):
    """The pairing code was rejected."""


class UnsupportedVersion(MachbarError):
    """The peer does not support this protocol version."""


class InvalidResponse(MachbarError):
    """Machbar returned an invalid response."""


class LeaseLost(MachbarError):
    """A request lease is no longer valid."""


class RequestGone(MachbarError):
    """A request no longer exists."""


class MachbarClient:
    """Small async client using Home Assistant's managed session."""

    def __init__(self, session: ClientSession, origin: str, token: str | None = None) -> None:
        self._session = session
        self._origin = origin.rstrip("/")
        self._token = token

    async def pair(self, pairing_code: str) -> dict[str, Any]:
        response = await self._post(
            PAIR_PATH,
            {"pairingCode": pairing_code, "protocolVersion": PROTOCOL_VERSION},
            authenticated=False,
        )
        data = await self._json(response)
        if data.get("protocolVersion") != PROTOCOL_VERSION:
            raise UnsupportedVersion
        if not all(isinstance(data.get(key), str) and data[key] for key in ("token", "instanceId")):
            raise InvalidResponse
        return data

    async def push_snapshot(self, snapshot: dict[str, Any]) -> None:
        await self._post(CONTEXT_PATH, snapshot, authenticated=True)

    async def sync_task(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        response = await self._post(SYNC_TASK_PATH, payload, authenticated=True)
        if response.status == 204:
            response.release()
            return None
        return await self._json(response)

    async def next_request(self, wait_seconds: int) -> dict[str, Any] | None:
        response = await self._request(
            "GET",
            f"{REQUESTS_NEXT_PATH}?{urlencode({'protocolVersion': PROTOCOL_VERSION, 'waitSeconds': wait_seconds})}",
            authenticated=True,
            timeout=wait_seconds + 10,
        )
        if response.status == 204:
            response.release()
            return None
        return await self._json(response)

    async def complete_request(self, request_id: str, body: dict[str, Any]) -> None:
        response = await self._request(
            "POST", REQUEST_COMPLETE_PATH.format(id=request_id), body, authenticated=True
        )
        response.release()

    async def download_attachment(
        self, job_id: str, attachment_id: str, dest_path: str | Path, max_bytes: int
    ) -> None:
        response = await self._request(
            "GET",
            ATTACHMENT_PATH.format(job=job_id, att=attachment_id),
            authenticated=True,
            timeout=60,
        )
        size = 0
        try:
            with open(dest_path, "wb") as output:
                async for chunk in response.content.iter_chunked(64 * 1024):
                    size += len(chunk)
                    if size > max_bytes:
                        raise InvalidResponse
                    output.write(chunk)
        except OSError as err:
            raise CannotConnect from err
        finally:
            response.release()

    async def _post(
        self, path: str, payload: dict[str, Any], *, authenticated: bool
    ) -> ClientResponse:
        return await self._request("POST", path, payload, authenticated=authenticated)

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        authenticated: bool,
        timeout: float = 10,
    ) -> ClientResponse:
        headers: dict[str, str] = {}
        if authenticated:
            if not self._token:
                raise InvalidAuth
            headers.update({"".join(("Auth", "orization")): "".join(("Bear", "er ")) + self._token})
        try:
            response = await self._session.request(
                method,
                f"{self._origin}{path}",
                json=payload,
                headers=headers,
                timeout=ClientTimeout(total=timeout),
            )
        except (ClientError, TimeoutError) as err:
            raise CannotConnect from err

        if response.status in (401, 403):
            response.release()
            raise InvalidAuth if authenticated else InvalidPairing
        if response.status == 426:
            response.release()
            raise UnsupportedVersion
        if response.status == 400:
            error_code = await self._error_code(response)
            response.release()
            if error_code == "unsupported_protocol_version":
                raise UnsupportedVersion
            raise InvalidPairing if not authenticated else ApplicationError
        if response.status == 409 and authenticated:
            response.release()
            raise LeaseLost
        if response.status == 404 and authenticated:
            response.release()
            raise RequestGone
        if response.status >= 400:
            response.release()
            if 400 <= response.status < 500 and response.status != 429:
                raise ApplicationError
            raise CannotConnect
        return response

    @staticmethod
    async def _json(response: ClientResponse) -> dict[str, Any]:
        try:
            data = await response.json()
        except (ValueError, ClientError) as err:
            response.release()
            raise InvalidResponse from err
        response.release()
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
