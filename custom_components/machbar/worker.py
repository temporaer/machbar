"""Background worker for Machbar reverse requests."""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any

from .calendar_bridge import async_create_event
from .cleanup_round import async_analyze_cleanup_round
from .client import (
    ApplicationError,
    CannotConnect,
    InvalidAuth,
    LeaseLost,
    MachbarClient,
    RequestGone,
    UnsupportedVersion,
)
from .const import BACKOFF_INITIAL, BACKOFF_MAX, LONG_POLL_SECONDS
from .intake import AdapterError, async_analyze

_LOGGER = logging.getLogger(__name__)


class RequestWorker:
    """Poll and execute Machbar requests without blocking entry setup."""

    def __init__(self, hass: Any, entry: Any) -> None:
        self.hass = hass
        self.entry = entry
        from . import async_get_clientsession

        self.client = MachbarClient(
            async_get_clientsession(hass), entry.data["origin"], entry.data["token"]
        )
        self._task: asyncio.Task[Any] | None = None
        self._stopped = False

    async def async_start(self) -> None:
        self._stopped = False
        creator = getattr(self.hass, "async_create_background_task", self.hass.async_create_task)
        self._task = creator(self._run(), "machbar request worker")

    async def async_stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _run(self) -> None:
        backoff = BACKOFF_INITIAL
        while not self._stopped:
            try:
                request = await self.client.next_request(LONG_POLL_SECONDS)
                if request is None:
                    await asyncio.sleep(0)
                    continue
                await self._handle(request)
                backoff = BACKOFF_INITIAL
            except InvalidAuth:
                _LOGGER.error("Machbar rejected the worker credentials")
                return
            except UnsupportedVersion:
                _LOGGER.error("Machbar requires a newer Home Assistant integration")
                return
            except ApplicationError:
                _LOGGER.error("Machbar rejected a worker request")
                await asyncio.sleep(random.uniform(backoff * 0.5, backoff))
                backoff = min(BACKOFF_MAX, backoff * 2)
            except (CannotConnect, asyncio.TimeoutError):
                await asyncio.sleep(random.uniform(backoff * 0.5, backoff))
                backoff = min(BACKOFF_MAX, backoff * 2)
            except Exception:
                _LOGGER.exception("Unexpected error in the Machbar request worker")
                await asyncio.sleep(random.uniform(backoff * 0.5, backoff))
                backoff = min(BACKOFF_MAX, backoff * 2)

    async def _handle(self, request: dict[str, Any]) -> None:
        kind = request.get("kind")
        payload = request.get("payload", {})
        try:
            if kind == "intake_analyze":
                result = await async_analyze(
                    self.hass, self.client, self.entry.options.get("ai_task_entity_id"), payload
                )
            elif kind == "cleanup_round_analyze":
                result = await async_analyze_cleanup_round(
                    self.hass, self.entry.options.get("ai_task_entity_id"), payload
                )
            elif kind == "calendar_create":
                result = await async_create_event(
                    self.hass, self.entry.options.get("calendar_entity_id"), payload
                )
            else:
                await self._complete(request, {"outcome": "failed", "error": {"code": "unsupported_request", "message": "Unsupported request"}})
                return
            await self._complete(request, {"outcome": "succeeded", "result": result})
        except AdapterError as err:
            error: dict[str, Any] = {"code": err.code, "message": str(err)}
            if err.details:
                error["details"] = err.details
            await self._complete(
                request,
                {"outcome": "failed", "error": error},
            )
        except (LeaseLost, RequestGone):
            _LOGGER.debug("Machbar request %s is no longer active", request.get("id"))
        except (InvalidAuth, UnsupportedVersion):
            raise
        except Exception:
            _LOGGER.exception("Unexpected error processing Machbar request %s", request.get("id"))
            await self._complete(
                request,
                {
                    "outcome": "failed",
                    "error": {
                        "code": "unexpected_error",
                        "message": "Home Assistant could not process this request.",
                    },
                },
            )

    async def _complete(self, request: dict[str, Any], body: dict[str, Any]) -> None:
        deadline = request.get("leaseExpiresAt")
        delay = BACKOFF_INITIAL
        while True:
            try:
                await self.client.complete_request(
                    request["id"], {"leaseToken": request["leaseToken"], **body}
                )
                return
            except (LeaseLost, RequestGone):
                raise
            except (CannotConnect, asyncio.TimeoutError):
                if deadline:
                    from datetime import datetime
                    from datetime import UTC
                    if datetime.fromisoformat(deadline.replace("Z", "+00:00")).astimezone(UTC).timestamp() <= datetime.now(UTC).timestamp():
                        raise
                await asyncio.sleep(min(delay, BACKOFF_MAX))
                delay = min(BACKOFF_MAX, delay * 2)
