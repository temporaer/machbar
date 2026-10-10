"""Tests for the Machbar request worker."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.machbar.const import DOMAIN
from custom_components.machbar.intake import AdapterError
from custom_components.machbar.worker import RequestWorker


async def test_worker_handles_empty_poll(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, data={"origin": "http://x", "token": "t"}, options={}
    )
    with patch(
        "custom_components.machbar.worker.MachbarClient.next_request",
        AsyncMock(return_value=None),
    ), patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)
        await worker.async_start()
        await worker.async_stop()


async def test_unexpected_request_failure_is_reported_and_worker_continues(hass, caplog):
    entry = MockConfigEntry(
        domain=DOMAIN, data={"origin": "http://x", "token": "t"}, options={}
    )
    requests = [
        {"id": "first", "kind": "intake_analyze", "payload": {}, "leaseToken": "one"},
        {"id": "second", "kind": "intake_analyze", "payload": {}, "leaseToken": "two"},
    ]

    with patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)

    worker.client.next_request = AsyncMock(side_effect=requests)

    async def complete_request(request_id, body):
        if request_id == "second":
            worker._stopped = True

    worker.client.complete_request = AsyncMock(side_effect=complete_request)
    with patch(
        "custom_components.machbar.worker.async_analyze",
        AsyncMock(side_effect=[RuntimeError("unexpected handler failure"), {"summary": "ok"}]),
    ):
        await worker._run()

    assert worker.client.complete_request.await_args_list[0].args == ("first", {
        "leaseToken": "one",
        "outcome": "failed",
        "error": {
            "code": "unexpected_error",
            "message": "Home Assistant could not process this request.",
        },
    })
    assert worker.client.complete_request.await_args_list[1].args == (
        "second",
        {"leaseToken": "two", "outcome": "succeeded", "result": {"summary": "ok"}},
    )
    assert any(
        record.getMessage().startswith("Unexpected error processing Machbar request first")
        and record.exc_info
        for record in caplog.records
    )


async def test_worker_does_not_swallow_cancellation(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, data={"origin": "http://x", "token": "t"}, options={}
    )
    with patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)
    worker.client.complete_request = AsyncMock()

    with patch(
        "custom_components.machbar.worker.async_analyze",
        AsyncMock(side_effect=asyncio.CancelledError),
    ):
        with pytest.raises(asyncio.CancelledError):
            await worker._handle(
                {
                    "id": "cancelled",
                    "kind": "intake_analyze",
                    "payload": {},
                    "leaseToken": "token",
                }
            )


async def test_worker_preserves_refinement_validation_error_for_api_retry(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, data={"origin": "http://x", "token": "t"}, options={},
    )
    with patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)
    worker.client.complete_request = AsyncMock()
    with patch(
        "custom_components.machbar.worker.async_analyze",
        AsyncMock(side_effect=AdapterError(
            "ai_task_invalid_response", "Invalid work refinement response.",
            path=["changes", 0, "kind"], expected_type="a supported change kind",
        )),
    ):
        await worker._handle({
            "id": "refinement", "kind": "intake_analyze",
            "payload": {"analysisMode": "work_refinement"}, "leaseToken": "lease",
        })
    body = worker.client.complete_request.await_args.args[1]
    assert body["outcome"] == "failed"
    assert body["error"]["code"] == "ai_task_invalid_response"
    assert body["error"]["details"]["path"] == ["changes", 0, "kind"]

    worker.client.complete_request.assert_not_awaited()
