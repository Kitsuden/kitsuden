"""
The Python client (sync and async) against a REAL Kitsuden API on a test
database. Started by ``node scripts/sdk/integration.mjs``; skipped when run alone.
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from kitsuden import (
    AsyncKitsudenApi,
    KitsudenApi,
    KitsudenApiError,
    Ok,
    ProposalPending,
    RequestOptions,
    expect_ok,
)

pytestmark = pytest.mark.skipif(os.environ.get("KITSUDEN_SDK_IT") != "1", reason="needs scripts/sdk/integration.mjs")

STAMP = format(int(time.time() * 1000), "x")


@pytest.fixture(scope="module")
def agent():
    with KitsudenApi() as k:  # KITSUDEN_API_URL + KITSUDEN_API_TOKEN
        yield k


@pytest.fixture(scope="module")
def admin():
    with KitsudenApi(token=False, session_cookie=os.environ.get("KITSUDEN_SDK_IT_COOKIE")) as k:
        yield k


@pytest.fixture(scope="module")
def dataset(agent: KitsudenApi, admin: KitsudenApi):
    expect_ok(admin.approvals.save_approvals_configuration(body={"enabled": True}))
    expect_ok(admin.approvals.agent_mode(id=os.environ["KITSUDEN_SDK_IT_PROPOSE_ID"], body={"mode": "propose"}))
    expect_ok(admin.approvals.agent_mode(id=os.environ["KITSUDEN_SDK_IT_DIRECT_ID"], body={"mode": "direct"}))
    body = {
        "name": f"SDK PY {STAMP}",
        "slug": f"sdk-py-{STAMP}",
        "schema": [{"name": "score", "fieldName": "score", "type": "number", "fieldType": "number"}],
    }
    r = agent.datasets.create_dataset(body=body)
    assert isinstance(r, Ok) and r.status == 201
    assert r.meta.idempotency_key and r.meta.idempotency_key.startswith("ksdk-") and not r.meta.replayed
    other = agent.datasets.create_dataset(body=body, request_options=RequestOptions(idempotency_key=r.meta.idempotency_key))
    assert isinstance(other, Ok) and other.meta.replayed and other.data["id"] == r.data["id"]
    yield r.data
    expect_ok(admin.approvals.save_approvals_configuration(body={"enabled": False}))


def test_entries_formats_and_provenance(agent: KitsudenApi, dataset):
    for i in range(3):
        expect_ok(agent.datasets.create_entry(id=dataset["id"], body={"title": f"e{i}", "data": {"score": i}}))
    items = expect_ok(agent.datasets.list_entries(id=dataset["id"], limit=10))
    assert sorted(d["title"] for d in items["docs"]) == ["e0", "e1", "e2"]
    for fmt in ("toon", "tron", "auto"):
        r = agent.datasets.list_entries(id=dataset["id"], limit=10, request_options=RequestOptions(format=fmt))
        assert expect_ok(r) == items, fmt
        assert r.meta.format is not None
    r = agent.datasets.list_entries(id=dataset["id"], request_options=RequestOptions(provenance=True))
    assert isinstance(r, Ok)


def test_typed_problem(agent: KitsudenApi, dataset):
    with pytest.raises(KitsudenApiError) as e:
        agent.datasets.get_dataset(id="0c6e1c2e-0000-4000-8000-00000000dead")
    assert e.value.code == "KITSUDEN_E_NOT_FOUND" and e.value.status == 404 and e.value.problem["hint"]


def test_proposal_pending_async(dataset):
    async def main() -> None:
        async with AsyncKitsudenApi(token=os.environ["KITSUDEN_SDK_IT_PROPOSE_TOKEN"]) as k:
            r = await k.datasets.create_dataset(body={"name": f"SDK PY held {STAMP}", "slug": f"sdk-py-held-{STAMP}"})
            assert isinstance(r, ProposalPending), r
            assert r.proposal["status"] == "pending" and r.proposal["id"] in r.proposal["statusUrl"]
            assert r.meta.attempts == 1
            status = expect_ok(await k.proposals.proposal_status(id=r.proposal["id"]))
            assert "pending" in str(status)

    asyncio.run(main())


def test_admin_iterates_pending_proposals(admin: KitsudenApi, dataset):
    seen = list(admin.approvals.iter_list_proposals(status="pending", limit=50))
    assert seen
