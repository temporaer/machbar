"""Packaged Python client against the actual built Node server over loopback.

No Home Assistant account, AI provider or production service is contacted.
"""
from datetime import UTC, datetime
import asyncio
import os
from pathlib import Path
import shutil

import aiohttp
import pytest

from custom_components.machbar.client import MachbarClient, InvalidAuth

pytestmark = pytest.mark.skipif(
    os.environ.get("CODEX_SANDBOX_NETWORK_DISABLED") == "1",
    reason="Loopback integration is exercised by CI outside the offline sandbox",
)


@pytest.fixture
async def live_api(tmp_path, socket_enabled, unused_tcp_port):
    root = Path(__file__).resolve().parents[1]
    entry = root / "apps/api/dist/index.js"
    assert entry.exists(), "Run npm run build before the cross-runtime contract tests"
    node = shutil.which("node")
    assert node is not None
    origin = f"http://127.0.0.1:{unused_tcp_port}"
    process = await asyncio.create_subprocess_exec(
        node, str(entry), cwd=root,
        env={"PATH": os.environ["PATH"], "NODE_ENV": "test", "PORT": str(unused_tcp_port),
             "HOST": "127.0.0.1", "DATA_DIR": str(tmp_path), "SEED_DATABASE": "false",
             "WEB_DIST_DIR": str(root / "apps/web/dist"), "ALLOW_UNAUTHENTICATED": "true"},
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with aiohttp.ClientSession() as session:
            for _ in range(100):
                if process.returncode is not None:
                    raise AssertionError((await process.stderr.read()).decode())
                try:
                    async with session.get(origin + "/api/health") as response:
                        if response.status == 200:
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.05)
            else:
                raise AssertionError("Isolated Node API did not start")
            yield session, origin
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


async def test_python_client_pairs_polls_and_completes_real_api_request(live_api):
    session, origin = live_api
    async with session.post(origin + "/api/integrations/home-assistant/pairing-code", json={}) as response:
        assert response.status == 201
        code = (await response.json())["code"]
    pairing = await MachbarClient(session, origin).pair(code)
    client = MachbarClient(session, origin, pairing["token"])
    await client.push_snapshot({
        "protocolVersion": 3, "observedAt": datetime.now(UTC).isoformat(), "contexts": [], "people": [],
        "intake": {"aiTask": {"entityId": "ai_task.test", "state": "ok", "supportsAttachments": True},
                   "calendar": {"entityId": "calendar.test", "state": "ok"}},
    })
    assert await client.next_request(0) is None
    form = aiohttp.FormData()
    form.add_field("text", "A real protocol round trip", content_type="text/plain")
    async with session.post(origin + "/api/intake", data=form) as response:
        assert response.status == 201, await response.text()
        job = await response.json()
    request = await client.next_request(0)
    assert request["kind"] == "intake_analyze"
    result = {"summary": "Protocol test", "calendarEvents": [], "workItems": [], "warnings": []}
    await client.complete_request(request["id"], {"leaseToken": request["leaseToken"], "outcome": "succeeded", "result": result})
    async with session.get(origin + f"/api/intake/{job['id']}") as response:
        assert response.status == 200
        assert (await response.json())["status"] == "ready"
    assert await client.next_request(0) is None


async def test_python_client_rejects_real_api_invalid_auth(live_api):
    session, origin = live_api
    client = MachbarClient(session, origin, "invalid_test_token")
    with pytest.raises(InvalidAuth):
        await client.next_request(0)
