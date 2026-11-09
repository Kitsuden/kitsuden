"""
The typed Kitsuden client: one attribute per kon, one typed method per
operation, generated from the API's OpenAPI 3.1 (``kitsuden/_generated``).

Five lines to the first call::

    from kitsuden import KitsudenApi

    kitsuden = KitsudenApi()  # KITSUDEN_API_URL + KITSUDEN_API_TOKEN
    res = kitsuden.media.list_media(limit=5)
    if res.ok:
        print([post["title"] for post in res.data["docs"]])

Async, same contract::

    async with AsyncKitsudenApi() as kitsuden:
        res = await kitsuden.media.list_media(limit=5)
"""

from __future__ import annotations

import asyncio
import importlib
import os
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Union

import httpx

from ._generated import KONS, AsyncGeneratedKons, GeneratedKons
from ._runtime import (
    Config,
    Format,
    OperationInfo,
    Outcome,
    RequestOptions,
    RetryPolicy,
    decide,
    network_decision,
    normalize_base_url,
    prepare,
    random_idempotency_key,
    raw_info,
)

__all__ = ["KitsudenApi", "AsyncKitsudenApi", "create_kitsuden"]

_USER_AGENT = "kitsuden-python"


def _config(
    base_url: Optional[str],
    token: Union[str, None, bool],
    session_cookie: Optional[str],
    format: Format,
    provenance: bool,
    untrusted_wrap: Optional[str],
    headers: Optional[Mapping[str, str]],
    timeout: float,
    retry: Union[RetryPolicy, bool, None],
    idempotency_key: Optional[Callable[[], str]],
) -> Config:
    url = base_url or os.environ.get("KITSUDEN_API_URL", "").strip()
    if not url:
        raise ValueError(
            "Kitsuden: no API URL. Pass base_url= or set KITSUDEN_API_URL (the origin, e.g. http://localhost:13000)."
        )
    if token is False:
        tok: Optional[str] = None
    elif isinstance(token, str):
        tok = token
    else:
        tok = os.environ.get("KITSUDEN_API_TOKEN", "").strip() or None
    if retry is False:
        policy = RetryPolicy(max_retries=0)
    elif isinstance(retry, RetryPolicy):
        policy = retry
    else:
        policy = RetryPolicy()
    return Config(
        base_url=normalize_base_url(url),
        token=tok,
        session_cookie=session_cookie,
        format=format,
        provenance=provenance,
        untrusted_wrap=untrusted_wrap,
        headers={"user-agent": _USER_AGENT, **dict(headers or {})},
        timeout=timeout,
        retry=policy,
        new_idempotency_key=idempotency_key or random_idempotency_key,
    )


def _send(prep: Any) -> Dict[str, Any]:
    kw: Dict[str, Any] = {"headers": prep.headers, "timeout": prep.timeout, "follow_redirects": False}
    if prep.content is not None:
        kw["content"] = prep.content
    if prep.files is not None:
        kw["files"] = prep.files
    if prep.data is not None:
        kw["data"] = prep.data
    return kw


class KitsudenApi(GeneratedKons):
    """Typed sync client. Each kon is an attribute (``client.blog``); see ``operations``."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        token: Union[str, None, bool] = None,
        session_cookie: Optional[str] = None,
        format: Format = "json",
        provenance: bool = False,
        untrusted_wrap: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: float = 30.0,
        retry: Union[RetryPolicy, bool, None] = None,
        idempotency_key: Optional[Callable[[], str]] = None,
        http_client: Optional[httpx.Client] = None,
        transport: Optional[httpx.BaseTransport] = None,
        sleep: Optional[Callable[[float], None]] = None,
    ):
        """
        Args:
            base_url: API origin. Default ``KITSUDEN_API_URL``. No localhost default.
            token: agent key (``kitsuden_agent_…``). Default ``KITSUDEN_API_TOKEN``; False = none.
            session_cookie: ``better-auth.session_token=…`` to act as a signed-in user.
            format: response wire format (json, toon, tron, auto). Bodies are always decoded.
            provenance: ask who wrote each row on every call.
            retry: a ``RetryPolicy``, or False to never retry.
            http_client / transport: your own ``httpx`` client or transport (tests).
        """
        self._cfg = _config(base_url, token, session_cookie, format, provenance, untrusted_wrap, headers, timeout, retry, idempotency_key)
        self._own = http_client is None
        self._http = http_client or httpx.Client(transport=transport)
        self._sleep = sleep or time.sleep

    @property
    def base_url(self) -> str:
        return self._cfg.base_url

    @property
    def operations(self) -> List[OperationInfo]:
        """Every operation this client knows (kon, id, method, path, scope, MCP tool…)."""
        return _all_operations()

    def __getattr__(self, name: str) -> Any:
        group = _kon_group(self, name, asynchronous=False)
        setattr(self, name, group)
        return group

    def __dir__(self) -> List[str]:
        return sorted(set(super().__dir__()) | {k[0] for k in KONS})

    def _execute(self, info: OperationInfo, params: Mapping[str, Any], body: Any, options: Optional[RequestOptions]) -> Any:
        prep = prepare(self._cfg, info, params, body, options)
        attempt = 0
        while True:
            try:
                res = self._http.request(prep.method, prep.url, **_send(prep))
                res.read()
            except httpx.TransportError as err:
                kind, value = network_decision(err, prep, attempt, self._cfg)
            else:
                kind, value = decide(res, prep, attempt, self._cfg)
            if kind == "done":
                return value
            if kind == "raise":
                raise value
            self._sleep(value)
            attempt += 1

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        body_format: str = "json",
        request_options: Optional[RequestOptions] = None,
    ) -> Outcome[Any]:
        """Any route, untyped (``path`` under ``/api``). Same auth, retries, formats and approvals."""
        info = raw_info(method.upper(), path, query, body is not None, body_format)
        return self._execute(info, dict(query or {}), body, request_options)

    def close(self) -> None:
        if self._own:
            self._http.close()

    def __enter__(self) -> "KitsudenApi":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncKitsudenApi(AsyncGeneratedKons):
    """Typed async client (``httpx.AsyncClient``). Same contract as ``KitsudenApi``."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        token: Union[str, None, bool] = None,
        session_cookie: Optional[str] = None,
        format: Format = "json",
        provenance: bool = False,
        untrusted_wrap: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: float = 30.0,
        retry: Union[RetryPolicy, bool, None] = None,
        idempotency_key: Optional[Callable[[], str]] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        sleep: Optional[Callable[[float], Any]] = None,
    ):
        self._cfg = _config(base_url, token, session_cookie, format, provenance, untrusted_wrap, headers, timeout, retry, idempotency_key)
        self._own = http_client is None
        self._http = http_client or httpx.AsyncClient(transport=transport)
        self._sleep = sleep or asyncio.sleep

    @property
    def base_url(self) -> str:
        return self._cfg.base_url

    @property
    def operations(self) -> List[OperationInfo]:
        return _all_operations()

    def __getattr__(self, name: str) -> Any:
        group = _kon_group(self, name, asynchronous=True)
        setattr(self, name, group)
        return group

    def __dir__(self) -> List[str]:
        return sorted(set(super().__dir__()) | {k[0] for k in KONS})

    async def _execute(self, info: OperationInfo, params: Mapping[str, Any], body: Any, options: Optional[RequestOptions]) -> Any:
        prep = prepare(self._cfg, info, params, body, options)
        attempt = 0
        while True:
            try:
                res = await self._http.request(prep.method, prep.url, **_send(prep))
                await res.aread()
            except httpx.TransportError as err:
                kind, value = network_decision(err, prep, attempt, self._cfg)
            else:
                kind, value = decide(res, prep, attempt, self._cfg)
            if kind == "done":
                return value
            if kind == "raise":
                raise value
            await self._sleep(value)
            attempt += 1

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        body_format: str = "json",
        request_options: Optional[RequestOptions] = None,
    ) -> Outcome[Any]:
        info = raw_info(method.upper(), path, query, body is not None, body_format)
        return await self._execute(info, dict(query or {}), body, request_options)

    async def aclose(self) -> None:
        if self._own:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncKitsudenApi":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()


_BY_ATTRIBUTE = {k[0]: k for k in KONS}


def _kon_group(client: Any, name: str, asynchronous: bool) -> Any:
    """Import the kon module on first use (importing all 39 up front costs ~0.5 s)."""
    entry = _BY_ATTRIBUTE.get(name)
    if entry is None or name.startswith("_"):
        raise AttributeError(f"{type(client).__name__!r} has no attribute {name!r} (no installed kon is called that)")
    _attr, _kon, module, kind = entry
    mod = importlib.import_module(module)
    return getattr(mod, f"Async{kind}" if asynchronous else kind)(client)


def _all_operations() -> List[OperationInfo]:
    output: List[OperationInfo] = []
    for _attr, _kon, module, _kind in KONS:
        ops: Dict[str, OperationInfo] = getattr(importlib.import_module(module), "OPERATIONS", {})
        output.extend(ops.values())
    return output


def create_kitsuden(base_url: Optional[str] = None, **kwargs: Any) -> KitsudenApi:
    """``KitsudenApi(base_url, **kwargs)``."""
    return KitsudenApi(base_url, **kwargs)
