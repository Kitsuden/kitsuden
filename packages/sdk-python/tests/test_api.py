"""
Typed client (``KitsudenApi`` / ``AsyncKitsudenApi``) against a mocked server.

``httpx.MockTransport`` answers each request; the tests check the contract the
twin TypeScript suite checks (packages/sdk/tests/client.test.ts): auth,
idempotency, retries, approvals, formats, provenance, pagination and errors.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Callable, List, Optional, Union

import httpx
import pytest

from kitsuden import (
    API_VERSION,
    ERROR_CODES,
    AsyncKitsudenApi,
    KitsudenApi,
    KitsudenApiError,
    KitsudenNetworkError,
    Ok,
    ProposalPending,
    ProposalPendingError,
    RequestOptions,
    RetryPolicy,
    decode_tron,
    expect_ok,
    parse_retry_after,
    provenance_of,
)
from kitsuden._toon import decode_toon
from kitsuden._tron import TronDecodeError

BASE = "http://kitsuden.test"
ROOT = Path(__file__).resolve().parents[3]
SPEC = json.loads((ROOT / "packages/sdk/openapi/kitsuden.openapi.json").read_text(encoding="utf-8"))
TRON = json.loads((Path(__file__).parent / "fixtures/tron-cases.json").read_text(encoding="utf-8"))

Reply = Union[httpx.Response, Exception, Callable[[httpx.Request], httpx.Response]]


class Server:
    """Records each request and answers from a queue (the last answer repeats)."""

    def __init__(self, *replies: Reply):
        self.replies: List[Reply] = list(replies)
        self.requests: List[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        r = self.replies.pop(0) if len(self.replies) > 1 else (self.replies[0] if self.replies else json_(200, {}))
        if isinstance(r, Exception):
            raise r
        if callable(r) and not isinstance(r, httpx.Response):
            return r(request)
        return httpx.Response(r.status_code, headers=r.headers, content=r.content)


def json_(status: int, body: Any, headers: Optional[dict] = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers or {})


def problem(code: str, status: int, headers: Optional[dict] = None, **extra: Any) -> httpx.Response:
    body = {"type": f"https://x/{code}", "title": code, "status": status, "detail": f"detail of {code}", "code": code,
            "retryable": False, "retry_after": None, "hint": "h", "docs": "d", **extra}
    return httpx.Response(status, content=json.dumps(body).encode(), headers={"content-type": "application/problem+json", **(headers or {})})


def client(server: Server, **kw: Any) -> KitsudenApi:
    waits: List[float] = []
    options: dict = {"token": "kitsuden_agent_test", "idempotency_key": lambda: "ksdk-fixed-key-0001", **kw}
    k = KitsudenApi(BASE, transport=httpx.MockTransport(server), sleep=waits.append, **options)
    k._cfg.random = lambda: 0.5
    k.waits = waits  # type: ignore[attr-defined]
    return k


# ── generated surface ────────────────────────────────────────────────────────


def test_one_method_per_operation_grouped_by_kon():
    spec_ops = sorted(
        f"{m.upper()} {p} {o['x-kitsuden-operation']['kon']}/{o['x-kitsuden-operation']['id']}"
        for p, item in SPEC["paths"].items() for m, o in item.items()
    )
    k = client(Server())
    from_client = sorted(f"{o.method} {o.path} {o.kon}/{o.id}" for o in k.operations)
    assert from_client == spec_ops
    from kitsuden._generated import KONS
    for attr, kon, _mod, _cls in KONS:
        group = getattr(k, attr)
        assert group.kon == kon
        ops = __import__(type(group).__module__, fromlist=["OPERATIONS"]).OPERATIONS
        methods = [n for n in vars(type(group)) if not n.startswith("_") and not n.startswith("iter_") and callable(getattr(group, n))]
        assert len(methods) == len(ops), kon
        paged = [n for n in vars(type(group)) if n.startswith("iter_")]
        assert len(paged) == sum(1 for o in ops.values() if o.pagination), kon


def test_error_codes_and_version_come_from_the_document():
    assert list(ERROR_CODES) == SPEC["components"]["schemas"]["Problem"]["properties"]["code"]["enum"]
    assert API_VERSION == SPEC["info"]["version"]


# ── configuration and auth ───────────────────────────────────────────────────


def test_env_url_and_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("KITSUDEN_API_URL", "http://from-env.test/api/")
    monkeypatch.setenv("KITSUDEN_API_TOKEN", "kitsuden_agent_env")
    s = Server(json_(200, {"docs": [], "totalDocs": 0}))
    k = KitsudenApi(transport=httpx.MockTransport(s))
    assert k.base_url == "http://from-env.test"
    k.datasets.list_datasets()
    assert str(s.requests[0].url) == "http://from-env.test/api/datasets"
    assert s.requests[0].headers["authorization"] == "Bearer kitsuden_agent_env"
    KitsudenApi(transport=httpx.MockTransport(s), token=False).datasets.list_datasets()
    assert "authorization" not in s.requests[1].headers


def test_no_url_no_guess(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("KITSUDEN_API_URL", raising=False)
    with pytest.raises(ValueError, match="KITSUDEN_API_URL"):
        KitsudenApi()


def test_session_cookie():
    s = Server(json_(200, {"docs": [], "totalDocs": 0}))
    k = client(s, token=False, session_cookie="better-auth.session_token=abc")
    k.datasets.list_datasets()
    assert s.requests[0].headers["cookie"] == "better-auth.session_token=abc"
    assert "authorization" not in s.requests[0].headers


# ── requests ─────────────────────────────────────────────────────────────────


def test_path_query_and_json_body():
    s = Server(json_(201, {"id": "e1"}))
    k = client(s)
    r = k.datasets.create_entry(id="a b/c", body={"title": "T", "data": {"n": 1}})
    assert isinstance(r, Ok) and r.ok
    req = s.requests[0]
    assert req.method == "POST"
    assert req.url.raw_path.decode() == "/api/datasets/a%20b%2Fc/entries"
    assert req.headers["content-type"] == "application/json"
    assert json.loads(req.content) == {"title": "T", "data": {"n": 1}}
    k.datasets.list_entries(id="d1", limit=5, include_calculated="true")
    assert s.requests[1].url.query.decode() == "limit=5&includeCalculated=true"


def test_missing_path_parameter_is_caught_before_sending():
    s = Server()
    with pytest.raises(TypeError, match="missing path parameter 'id'"):
        client(s).datasets.get_dataset(id="")
    assert s.requests == []


def test_idempotency_key_on_writes_only():
    s = Server(json_(201, {"id": "x"}))
    k = client(s)
    k.datasets.create_dataset(body={"name": "n"})
    k.datasets.list_datasets()
    k.datasets.create_dataset(body={"name": "n"}, request_options=RequestOptions(idempotency_key="mine-123456"))
    k.datasets.create_dataset(body={"name": "n"}, request_options=RequestOptions(idempotency_key=False))
    assert [r.headers.get("idempotency-key") for r in s.requests] == ["ksdk-fixed-key-0001", None, "mine-123456", None]


def test_generated_keys_match_the_server_pattern():
    import re

    s = Server(json_(201, {}))
    k = KitsudenApi(BASE, token=False, transport=httpx.MockTransport(s))
    k.datasets.create_dataset(body={"name": "n"})
    k.datasets.create_dataset(body={"name": "n"})
    a, b = (r.headers["idempotency-key"] for r in s.requests)
    assert re.fullmatch(r"[A-Za-z0-9_.:-]{8,128}", a) and a != b


# ── retries ──────────────────────────────────────────────────────────────────


def test_read_retried_on_503_with_retry_after():
    s = Server(problem("KITSUDEN_E_UNAVAILABLE", 503, {"retry-after": "2"}, retryable=True), json_(200, {"docs": [], "totalDocs": 0}))
    k = client(s)
    r = k.datasets.list_datasets()
    assert r.ok and len(s.requests) == 2 and k.waits == [2.0]  # type: ignore[attr-defined]
    assert r.meta.attempts == 2


def test_write_retried_with_the_same_key():
    s = Server(httpx.ConnectError("refused"), problem("KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS", 409, {"retry-after": "1"}, retryable=True), json_(201, {"id": "x"}))
    import secrets
    k = client(s, idempotency_key=lambda: f"ksdk-{secrets.token_hex(8)}")
    r = k.datasets.create_dataset(body={"name": "n"})
    assert r.ok and len(s.requests) == 3
    keys = {q.headers["idempotency-key"] for q in s.requests}
    assert len(keys) == 1 and r.meta.idempotency_key in keys


def test_write_without_key_is_not_retried():
    s = Server(httpx.ConnectError("refused"))
    with pytest.raises(KitsudenNetworkError):
        client(s).datasets.create_dataset(body={"name": "n"}, request_options=RequestOptions(idempotency_key=False))
    assert len(s.requests) == 1


def test_not_retryable_is_raised_at_once():
    s = Server(problem("KITSUDEN_E_VALIDATION", 422))
    with pytest.raises(KitsudenApiError) as e:
        client(s).datasets.list_datasets()
    assert e.value.code == "KITSUDEN_E_VALIDATION" and e.value.status == 422 and len(s.requests) == 1


def test_long_retry_after_is_not_waited():
    s = Server(problem("KITSUDEN_E_QUOTA_EXCEEDED", 429, {"retry-after": "3600"}, retryable=True, retry_after=3600))
    k = client(s)
    with pytest.raises(KitsudenApiError) as e:
        k.datasets.list_datasets()
    assert e.value.retry_after == 3600 and k.waits == []  # type: ignore[attr-defined]


def test_max_retries_and_retry_false():
    s = Server(problem("KITSUDEN_E_UNAVAILABLE", 503, retryable=True))
    k = client(s, retry=RetryPolicy(max_retries=3))
    with pytest.raises(KitsudenApiError):
        k.datasets.list_datasets()
    assert len(s.requests) == 4 and k.waits == [0.125, 0.25, 0.5]  # type: ignore[attr-defined]
    with pytest.raises(KitsudenApiError):
        k.datasets.list_datasets(request_options=RequestOptions(retry=False))
    assert len(s.requests) == 5


def test_retry_after_parsing():
    assert parse_retry_after("7") == 7.0
    assert parse_retry_after("Tue, 01 Jan 2030 00:00:30 GMT", now=1893456000.0) == 30.0
    assert parse_retry_after("soon") is None


# ── approvals ────────────────────────────────────────────────────────────────

PROPOSAL = {"id": "p-1", "status": "pending", "statusUrl": "/api/proposals/p-1"}


def test_202_approval_is_a_typed_pending_proposal_never_resent():
    s = Server(problem("KITSUDEN_E_APPROVAL_REQUIRED", 202, proposal=PROPOSAL))
    r = client(s).datasets.create_dataset(body={"name": "n"})
    assert isinstance(r, ProposalPending) and not r.ok and r.kind == "proposal_pending"
    assert r.proposal["statusUrl"] == "/api/proposals/p-1"
    assert r.problem["code"] == "KITSUDEN_E_APPROVAL_REQUIRED"
    assert len(s.requests) == 1
    with pytest.raises(ProposalPendingError):
        expect_ok(r)


def test_approval_recognized_by_code_whatever_the_media_type():
    body = {"type": "x", "title": "Pending human approval", "status": 202, "detail": "held",
              "code": "KITSUDEN_E_APPROVAL_REQUIRED", "retryable": False, "retry_after": None, "hint": "", "docs": "",
              "proposal": PROPOSAL}
    s = Server(json_(202, body))
    r = client(s).datasets.create_dataset(body={"name": "n"})
    assert isinstance(r, ProposalPending) and r.proposal["id"] == "p-1"


def test_plain_202_json_is_a_success():
    s = Server(json_(202, {"ok": True, "status": "sending"}))
    r = client(s).queue.retry_job(id="c1")
    assert expect_ok(r) == {"ok": True, "status": "sending"}


# ── errors ───────────────────────────────────────────────────────────────────


def test_problem_json_error():
    s = Server(problem("KITSUDEN_E_NOT_FOUND", 404, {"x-request-id": "req-9"}))
    with pytest.raises(KitsudenApiError) as e:
        client(s).datasets.get_dataset(id="nope")
    assert e.value.request_id == "req-9" and e.value.problem["hint"] == "h"
    assert "KITSUDEN_E_NOT_FOUND" in str(e.value)


def test_html_error_page_gets_the_same_shape_and_is_retried():
    s = Server(httpx.Response(502, content=b"<html>bad gateway</html>", headers={"content-type": "text/html"}))
    with pytest.raises(KitsudenApiError) as e:
        client(s).datasets.list_datasets()
    assert e.value.code == "KITSUDEN_E_INTERNAL" and "bad gateway" in e.value.problem["detail"]
    assert len(s.requests) == 3


def test_network_failure_of_a_read():
    s = Server(httpx.ConnectError("refused"))
    with pytest.raises(KitsudenNetworkError) as e:
        client(s).datasets.list_datasets()
    assert e.value.attempts == 3


# ── formats ──────────────────────────────────────────────────────────────────

DATA = {"docs": [{"id": "1", "name": "a"}, {"id": "2", "name": "b"}], "totalDocs": 2}


def test_toon():
    text = "docs[2]{id,name}:\n  \"1\",a\n  \"2\",b\ntotalDocs: 2"
    assert decode_toon(text) == DATA
    s = Server(httpx.Response(200, content=text.encode(), headers={"content-type": "application/vnd.toon", "x-kitsuden-format": "toon"}))
    r = client(s, format="toon").datasets.list_datasets()
    assert s.requests[0].headers["accept"] == "application/vnd.toon"
    assert expect_ok(r) == DATA and r.meta.format == "toon"


def test_tron_and_auto():
    case = next(c for c in TRON["cases"] if isinstance(c["json"], dict) and "docs" in c["json"])
    s = Server(
        httpx.Response(200, content=case["tron"].encode(), headers={"content-type": "application/vnd.tron", "x-kitsuden-format": "tron"}),
        json_(200, DATA, {"x-kitsuden-format": "json"}),
    )
    k = client(s, format="auto")
    assert expect_ok(k.datasets.list_datasets()) == case["json"]
    assert s.requests[0].headers["accept"] == "application/vnd.kitsuden.auto"
    assert expect_ok(k.datasets.list_datasets(request_options=RequestOptions(format="tron"))) == DATA
    assert s.requests[1].headers["accept"] == "application/vnd.tron"


def test_text_binary_and_204():
    s = Server(
        httpx.Response(200, content=b"# md", headers={"content-type": "text/markdown"}),
        httpx.Response(200, content=b"\x01\x02\x03", headers={"content-type": "application/pdf"}),
        httpx.Response(204),
    )
    k = client(s)
    assert expect_ok(k.request("GET", "/x.md")) == "# md"
    assert expect_ok(k.request("GET", "/x.pdf")) == b"\x01\x02\x03"
    assert expect_ok(k.request("DELETE", "/x")) is None


# ── provenance ───────────────────────────────────────────────────────────────


def test_provenance():
    row = {"id": "1", "_provenance": {"id": "1", "author": "user", "untrusted": True}}
    s = Server(json_(200, {"docs": [row], "totalDocs": 1}, {"x-kitsuden-provenance": "untrusted=1; user=1"}))
    r = client(s).datasets.list_datasets(request_options=RequestOptions(provenance=True))
    assert s.requests[0].headers["x-kitsuden-provenance"] == "1"
    assert r.meta.provenance is not None
    assert r.meta.provenance.untrusted == 1 and dict(r.meta.provenance.authors) == {"user": 1}
    assert provenance_of(expect_ok(r)["docs"][0]) == {"id": "1", "author": "user", "untrusted": True}


# ── pagination ───────────────────────────────────────────────────────────────


def test_pages_until_total_pages():
    def page(n: int, ids: List[str]) -> httpx.Response:
        return json_(200, {"docs": [{"id": i, "title": i} for i in ids], "totalPages": 3, "page": n, "limit": 2})

    s = Server(page(1, ["a", "b"]), page(2, ["c", "d"]), page(3, ["e"]))
    ids = [p["id"] for p in client(s).media.iter_list_media(limit=2)]
    assert ids == ["a", "b", "c", "d", "e"]
    assert [r.url.params.get("offset") for r in s.requests] == ["0", "2", "4"]


def test_pending_page_raises():
    s = Server(problem("KITSUDEN_E_APPROVAL_REQUIRED", 202, proposal=PROPOSAL))
    with pytest.raises(ProposalPendingError):
        list(client(s).media.iter_list_media())


# ── TRON parity ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", TRON["cases"], ids=[str(i) for i in range(len(TRON["cases"]))])
def test_tron_fixture(case):
    assert decode_tron(case["tron"]) == case["json"]


def test_tron_malformed():
    for bad in ("class A: x\n\nA(1", "B(1)", '{"a": 1} 2'):
        with pytest.raises(TronDecodeError):
            decode_tron(bad)


# ── async ────────────────────────────────────────────────────────────────────


def test_async_client_same_contract():
    s = Server(
        problem("KITSUDEN_E_UNAVAILABLE", 503, {"retry-after": "1"}, retryable=True),
        json_(200, {"docs": [{"id": "a", "title": "a"}], "totalPages": 1, "page": 1}),
        problem("KITSUDEN_E_APPROVAL_REQUIRED", 202, proposal=PROPOSAL),
    )
    waits: List[float] = []

    async def fake_sleep(t: float) -> None:
        waits.append(t)

    async def main() -> None:
        async with AsyncKitsudenApi(BASE, token="kitsuden_agent_test", transport=httpx.MockTransport(s), sleep=fake_sleep) as k:
            r = await k.media.list_media(limit=1)
            assert r.ok and waits == [1.0]
            pend = await k.datasets.create_dataset(body={"name": "n"})
            assert isinstance(pend, ProposalPending)
            assert pend.meta.idempotency_key and s.requests[-1].headers["idempotency-key"] == pend.meta.idempotency_key

    asyncio.run(main())


def test_async_iteration():
    s = Server(json_(200, {"docs": [{"id": "a", "title": "a"}, {"id": "b", "title": "b"}], "hasNextPage": False}))

    async def main() -> List[str]:
        async with AsyncKitsudenApi(BASE, token=False, transport=httpx.MockTransport(s)) as k:
            return [p["id"] async for p in k.media.iter_list_media()]

    assert asyncio.run(main()) == ["a", "b"]
