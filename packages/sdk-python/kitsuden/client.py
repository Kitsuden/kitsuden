"""
Kitsuden: the official Python client.

The twin of ``@kitsuden/sdk`` (TypeScript): same endpoints, same names, same
semantics. It is the entry point for the Python audience, especially AI
engineers whose agents use Kitsuden as a backend, without a single line of
Python on the server. The Supabase model: one backend, clients in every
language.

Usage::

    from kitsuden import KitsudenClient

    client = KitsudenClient("http://localhost:3001", api_key="kitsuden_sk_...")

    games = client.table("games").list(limit=10)
    game = client.table("games").create({"title": "Elden Ring"})

    hits = client.vector_search("dataset-id", "necromancer builds", limit=5)

    # Shorter responses over the network: the API sends compact JSON or TOON,
    # the shortest for each response (the data you receive is the same)
    lean = KitsudenClient(url, api_key=key, format="auto")

Async, same contract::

    from kitsuden import AsyncKitsudenClient

    async with AsyncKitsudenClient(url, api_key=key) as client:
        games = await client.table("games").list()
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, List, Mapping, Optional, Sequence, Tuple, Union
from urllib.parse import quote

import httpx

from ._transport import Request, KitsudenError, build_request, interpret_response

__all__ = [
    "KitsudenClient",
    "AsyncKitsudenClient",
    "KitsudenError",
    "ListResponse",
    "Pagination",
    "FILTER_OPS",
]


# ── Response types ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Pagination:
    page: int
    limit: int
    total: int
    total_pages: int
    has_next_page: bool
    has_prev_page: bool


@dataclass(frozen=True)
class ListResponse:
    """A page of results. Iterable: ``for row in response``."""

    data: list = field(default_factory=list)
    pagination: Optional[Pagination] = None

    def __iter__(self):
        return iter(self.data)

    def __len__(self):
        return len(self.data)

    @staticmethod
    def from_payload(payload: Any) -> "ListResponse":
        # The API returns {data, pagination}; if some endpoint returns a
        # bare list, it is wrapped so the SDK contract does not change.
        if isinstance(payload, list):
            return ListResponse(data=payload)
        data = payload.get("data", []) if isinstance(payload, dict) else []
        pg = payload.get("pagination") if isinstance(payload, dict) else None
        pagination = (
            Pagination(
                page=pg.get("page", 1),
                limit=pg.get("limit", len(data)),
                total=pg.get("total", len(data)),
                total_pages=pg.get("totalPages", 1),
                has_next_page=pg.get("hasNextPage", False),
                has_prev_page=pg.get("hasPrevPage", False),
            )
            if isinstance(pg, dict)
            else None
        )
        return ListResponse(data=data, pagination=pagination)


# ── Request construction per resource (pure, shared sync/async) ─────────────


#: The operators ``GET /api/explorer/:table`` understands (any other one is a 400).
FILTER_OPS = ("contains", "equals", "gt", "lt", "gte", "lte")

#: A filter value: sent as text (bool as ``true``/``false``, dates in ISO 8601).
FilterValue = Union[str, int, float, bool, date, datetime]

#: ``{"status": "draft", "price": {"gte": 10, "lt": 20}}``, or a list of
#: ``{"field": ..., "op": ..., "value": ...}`` (``op`` defaults to ``equals``).
Filters = Union[
    Mapping[str, Union[FilterValue, Mapping[str, Optional[FilterValue]], None]],
    Sequence[Mapping[str, Any]],
]


def _filter_text(value: Any) -> str:
    """The text the TS SDK would send (``String(value)``)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))  # JS writes 10.0 as "10"
    return str(value)


def _check_op(op: Any) -> str:
    if op not in FILTER_OPS:
        raise ValueError(
            f"Unsupported filter operator: {op!r} (supported: {', '.join(FILTER_OPS)})"
        )
    return op


def _filter_pairs(filters: Optional[Filters]) -> List[Tuple[str, str]]:
    """``filter[<col>]=<v>`` (equals) or ``filter[<col>][<op>]=<v>``, one pair per condition.

    A None value is skipped, like an ``undefined`` in the TS SDK. The operator is checked
    here so a typo fails before the request instead of as a 400.
    """
    if not filters:
        return []
    pairs: List[Tuple[str, str]] = []
    if isinstance(filters, Mapping):
        for field_name, condition in filters.items():
            if condition is None:
                continue
            if isinstance(condition, Mapping):
                for op, value in condition.items():
                    _check_op(op)
                    if value is not None:
                        pairs.append((f"filter[{field_name}][{op}]", _filter_text(value)))
            else:
                pairs.append((f"filter[{field_name}]", _filter_text(condition)))
        return pairs
    if isinstance(filters, (str, bytes)):
        raise TypeError("filters must be a dict or a list of {field, op, value}")
    for item in filters:
        if not isinstance(item, Mapping) or "field" not in item:
            raise TypeError("each filter in a list must be a dict with 'field' and 'value'")
        op = _check_op(item.get("op") or "equals")
        value = item.get("value")
        if value is None:
            continue
        key = f"filter[{item['field']}]" if op == "equals" else f"filter[{item['field']}][{op}]"
        pairs.append((key, _filter_text(value)))
    return pairs


def _list_params(
    limit: Optional[int] = None,
    page: Optional[int] = None,
    sort: Optional[str] = None,
    dir: Optional[str] = None,
    search: Optional[str] = None,
    search_fields: Union[Sequence[str], str, None] = None,
    filters: Optional[Filters] = None,
    filter_field: Optional[str] = None,
    filter_op: Optional[str] = None,
    filter_value: Optional[str] = None,
) -> List[Tuple[str, Any]]:
    """The explorer list query (apps/api/src/lib/explorer-query.ts), as a list of pairs
    so several conditions on one column survive the encoding."""
    if isinstance(search_fields, str):
        fields_text: Optional[str] = search_fields or None
    else:
        fields_text = ",".join(search_fields) if search_fields else None
    return [
        ("limit", limit),
        ("page", page),
        ("sort", sort),
        ("dir", dir),
        ("search", search or None),
        ("search_fields", fields_text),
        *_filter_pairs(filters),
        # The older single filter, still honoured (AND with `filters`).
        ("filter_field", filter_field),
        ("filter_op", filter_op),
        ("filter_value", filter_value),
    ]


def _history_params(limit: Optional[int], offset: Optional[int]) -> dict:
    return {"limit": limit, "offset": offset}


class _RequestFactory:
    """Builds `Request`s with the client configuration already applied."""

    def __init__(self, base_url: str, api_key: Optional[str], fmt: str):
        self.base_url = base_url
        self.api_key = api_key
        self.fmt = fmt

    def make(self, method: str, path: str, body=None, params=None) -> Request:
        return build_request(
            self.base_url, self.api_key, self.fmt, method, path, body, params
        )


# ── Resources ────────────────────────────────────────────────────────────────
#
# Each resource is defined ONCE as a generator of (Request, post-processing) and
# the sync/async clients differ only in how they execute. This way a new
# endpoint is added in a single place.


class _TableOps:
    """Operations on an explorer table (same path as the TS SDK)."""

    def __init__(self, factory: _RequestFactory, table: str):
        self._f = factory
        self._table = table

    def list_req(self, **kw) -> Request:
        return self._f.make("GET", f"/explorer/{self._table}", params=_list_params(**kw))

    def get_req(self, row_id: str) -> Request:
        return self._f.make("GET", f"/explorer/{self._table}/{row_id}")

    def create_req(self, data: dict) -> Request:
        return self._f.make("POST", f"/explorer/{self._table}", body=data)

    def update_req(self, row_id: str, data: dict) -> Request:
        return self._f.make("PATCH", f"/explorer/{self._table}/{row_id}", body=data)

    def delete_req(self, row_id: str) -> Request:
        return self._f.make("DELETE", f"/explorer/{self._table}/{row_id}")

    def options_req(self) -> Request:
        return self._f.make("GET", f"/explorer/{self._table}/options")

    def history_req(
        self, row_id: str, limit: Optional[int] = None, offset: Optional[int] = None
    ) -> Request:
        return self._f.make(
            "GET",
            f"/history/{self._table}/{quote(str(row_id), safe='')}",
            params=_history_params(limit, offset),
        )


class _CollectionOps:
    """Datasets (dynamic collections), by slug."""

    def __init__(self, factory: _RequestFactory, slug: str):
        self._f = factory
        self._slug = slug

    def entries_req(self, limit: Optional[int] = None, page: Optional[int] = None) -> Request:
        return self._f.make(
            "GET",
            f"/datasets/{self._slug}/entries",
            params={"limit": limit, "page": page},
        )

    def insert_req(self, data: dict) -> Request:
        # Yes, the write path differs from the read one; it is the API's current
        # contract and the TS SDK does exactly the same.
        return self._f.make("POST", f"/datasets/slug/{self._slug}/entries", body=data)


# ── Synchronous client ───────────────────────────────────────────────────────


class TableRef:
    def __init__(self, client: "KitsudenClient", table: str):
        self._client = client
        self._ops = _TableOps(client._factory, table)

    def list(
        self,
        limit: Optional[int] = None,
        page: Optional[int] = None,
        sort: Optional[str] = None,
        dir: Optional[str] = None,
        filter_field: Optional[str] = None,
        filter_op: Optional[str] = None,
        filter_value: Optional[str] = None,
        *,
        search: Optional[str] = None,
        search_fields: Union[Sequence[str], str, None] = None,
        filters: Optional[Filters] = None,
    ) -> ListResponse:
        """List rows. Every condition must hold (AND).

        ``search`` looks for text in any textual column (or only in ``search_fields``);
        ``filters`` takes ``{"status": "draft", "price": {"gte": 10, "lt": 20}}`` or a list
        of ``{"field", "op", "value"}``. Operators: contains, equals, gt, lt, gte, lte.
        """
        payload = self._client._send(
            self._ops.list_req(
                limit=limit,
                page=page,
                sort=sort,
                dir=dir,
                search=search,
                search_fields=search_fields,
                filters=filters,
                filter_field=filter_field,
                filter_op=filter_op,
                filter_value=filter_value,
            )
        )
        return ListResponse.from_payload(payload)

    def history(
        self, row_id: str, limit: Optional[int] = None, offset: Optional[int] = None
    ) -> Any:
        """Who created, changed or deleted a row, when, and which fields (newest first).

        Admin only (``GET /api/history/:table/:id``). Returns
        ``{"history": [...], "total", "limit", "offset"}``.
        """
        return self._client._send(self._ops.history_req(row_id, limit=limit, offset=offset))

    def get(self, row_id: str) -> Any:
        return self._client._send(self._ops.get_req(row_id))

    def create(self, data: dict) -> Any:
        return self._client._send(self._ops.create_req(data))

    def update(self, row_id: str, data: dict) -> Any:
        return self._client._send(self._ops.update_req(row_id, data))

    def delete(self, row_id: str) -> None:
        self._client._send(self._ops.delete_req(row_id))

    def options(self) -> Any:
        return self._client._send(self._ops.options_req())


class CollectionRef:
    def __init__(self, client: "KitsudenClient", slug: str):
        self._client = client
        self._ops = _CollectionOps(client._factory, slug)

    def entries(self, limit: Optional[int] = None, page: Optional[int] = None) -> ListResponse:
        payload = self._client._send(self._ops.entries_req(limit=limit, page=page))
        return ListResponse.from_payload(payload)

    def insert(self, data: dict) -> Any:
        return self._client._send(self._ops.insert_req(data))


class KitsudenClient:
    """Synchronous client. Reuses the connection (httpx.Client with pooling)."""

    def __init__(
        self,
        url: str,
        api_key: Optional[str] = None,
        format: str = "json",
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ):
        if format not in ("json", "toon", "auto"):
            raise ValueError('format must be "json", "toon" or "auto"')
        self._factory = _RequestFactory(url, api_key, format)
        # `transport` is injectable: tests use httpx.MockTransport and the SDK
        # is tested entirely without a network or server.
        self._http = httpx.Client(timeout=timeout, transport=transport)

    # -- infra --

    def _send(self, req: Request) -> Any:
        response = self._http.request(
            req.method, req.url, headers=req.headers, content=req.body
        )
        return interpret_response(response)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "KitsudenClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- public surface (mirror of the TS SDK) --

    def table(self, name: str) -> TableRef:
        """CRUD on any exposed table (core, kon or dataset)."""
        return TableRef(self, name)

    # from is a reserved word in Python; from_ keeps the familiarity
    # with supabase-py and with the TS SDK's `.from()`.
    def from_(self, name: str) -> TableRef:
        return self.table(name)

    def collection(self, slug: str) -> CollectionRef:
        """Dynamic collection (dataset) by slug."""
        return CollectionRef(self, slug)

    def schema(self, table: str) -> Any:
        return self._send(self._factory.make("GET", f"/explorer/schema/kons/{table}"))

    def modules(self) -> Any:
        payload = self._send(self._factory.make("GET", "/modules"))
        return payload.get("docs", payload) if isinstance(payload, dict) else payload

    def ping(self) -> bool:
        try:
            self._send(self._factory.make("GET", "/health"))
            return True
        except (KitsudenError, httpx.HTTPError):
            return False

    def vector_search(
        self,
        dataset_id: str,
        query: str,
        limit: int = 10,
        threshold: Optional[float] = None,
    ) -> Any:
        """Semantic search over a dataset (requires vector-search to be enabled)."""
        body: dict = {"query": query, "limit": limit}
        if threshold is not None:
            body["threshold"] = threshold
        return self._send(
            self._factory.make("POST", f"/datasets/{dataset_id}/vector-search", body=body)
        )

    def tree_retrieve(
        self,
        content: str,
        query: str,
        max_sections: int = 3,
        sections: Optional[list] = None,
    ) -> Any:
        """Tree retrieval (PageIndex-style): sections WITH their citation.

        The agent flow takes two steps: ask for the index with ``tree_index``
        and pass the chosen sections here; without ``sections`` the server's
        heuristic is used.
        """
        body: dict = {"content": content, "query": query, "maxSections": max_sections}
        if sections:
            body["sections"] = sections
        return self._send(self._factory.make("POST", "/brain/tree/retrieve", body=body))

    def tree_index(self, content: str, title: Optional[str] = None, depth: int = 3) -> Any:
        """Compact index of a document: it fits in context even if the document does not."""
        body: dict = {"content": content, "depth": depth}
        if title:
            body["title"] = title
        return self._send(self._factory.make("POST", "/brain/tree", body=body))


# ── Asynchronous client ──────────────────────────────────────────────────────
#
# Same contract, async execution. It shares _TableOps/_CollectionOps and the
# pure transport: the only difference is the await.


class AsyncTableRef:
    def __init__(self, client: "AsyncKitsudenClient", table: str):
        self._client = client
        self._ops = _TableOps(client._factory, table)

    async def list(
        self,
        limit: Optional[int] = None,
        page: Optional[int] = None,
        sort: Optional[str] = None,
        dir: Optional[str] = None,
        filter_field: Optional[str] = None,
        filter_op: Optional[str] = None,
        filter_value: Optional[str] = None,
        *,
        search: Optional[str] = None,
        search_fields: Union[Sequence[str], str, None] = None,
        filters: Optional[Filters] = None,
    ) -> ListResponse:
        """Same contract as :meth:`TableRef.list`."""
        payload = await self._client._send(
            self._ops.list_req(
                limit=limit,
                page=page,
                sort=sort,
                dir=dir,
                search=search,
                search_fields=search_fields,
                filters=filters,
                filter_field=filter_field,
                filter_op=filter_op,
                filter_value=filter_value,
            )
        )
        return ListResponse.from_payload(payload)

    async def history(
        self, row_id: str, limit: Optional[int] = None, offset: Optional[int] = None
    ) -> Any:
        """Same contract as :meth:`TableRef.history` (admin only)."""
        return await self._client._send(
            self._ops.history_req(row_id, limit=limit, offset=offset)
        )

    async def get(self, row_id: str) -> Any:
        return await self._client._send(self._ops.get_req(row_id))

    async def create(self, data: dict) -> Any:
        return await self._client._send(self._ops.create_req(data))

    async def update(self, row_id: str, data: dict) -> Any:
        return await self._client._send(self._ops.update_req(row_id, data))

    async def delete(self, row_id: str) -> None:
        await self._client._send(self._ops.delete_req(row_id))

    async def options(self) -> Any:
        return await self._client._send(self._ops.options_req())


class AsyncCollectionRef:
    def __init__(self, client: "AsyncKitsudenClient", slug: str):
        self._client = client
        self._ops = _CollectionOps(client._factory, slug)

    async def entries(
        self, limit: Optional[int] = None, page: Optional[int] = None
    ) -> ListResponse:
        payload = await self._client._send(self._ops.entries_req(limit=limit, page=page))
        return ListResponse.from_payload(payload)

    async def insert(self, data: dict) -> Any:
        return await self._client._send(self._ops.insert_req(data))


class AsyncKitsudenClient:
    """Asynchronous client, for agents and async-first services."""

    def __init__(
        self,
        url: str,
        api_key: Optional[str] = None,
        format: str = "json",
        timeout: float = 30.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        if format not in ("json", "toon", "auto"):
            raise ValueError('format must be "json", "toon" or "auto"')
        self._factory = _RequestFactory(url, api_key, format)
        self._http = httpx.AsyncClient(timeout=timeout, transport=transport)

    async def _send(self, req: Request) -> Any:
        response = await self._http.request(
            req.method, req.url, headers=req.headers, content=req.body
        )
        return interpret_response(response)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncKitsudenClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    def table(self, name: str) -> AsyncTableRef:
        return AsyncTableRef(self, name)

    def from_(self, name: str) -> AsyncTableRef:
        return self.table(name)

    def collection(self, slug: str) -> AsyncCollectionRef:
        return AsyncCollectionRef(self, slug)

    async def schema(self, table: str) -> Any:
        return await self._send(
            self._factory.make("GET", f"/explorer/schema/kons/{table}")
        )

    async def modules(self) -> Any:
        payload = await self._send(self._factory.make("GET", "/modules"))
        return payload.get("docs", payload) if isinstance(payload, dict) else payload

    async def ping(self) -> bool:
        try:
            await self._send(self._factory.make("GET", "/health"))
            return True
        except (KitsudenError, httpx.HTTPError):
            return False

    async def vector_search(
        self,
        dataset_id: str,
        query: str,
        limit: int = 10,
        threshold: Optional[float] = None,
    ) -> Any:
        body: dict = {"query": query, "limit": limit}
        if threshold is not None:
            body["threshold"] = threshold
        return await self._send(
            self._factory.make("POST", f"/datasets/{dataset_id}/vector-search", body=body)
        )

    async def tree_retrieve(
        self,
        content: str,
        query: str,
        max_sections: int = 3,
        sections: Optional[list] = None,
    ) -> Any:
        body: dict = {"content": content, "query": query, "maxSections": max_sections}
        if sections:
            body["sections"] = sections
        return await self._send(self._factory.make("POST", "/brain/tree/retrieve", body=body))

    async def tree_index(
        self, content: str, title: Optional[str] = None, depth: int = 3
    ) -> Any:
        body: dict = {"content": content, "depth": depth}
        if title:
            body["title"] = title
        return await self._send(self._factory.make("POST", "/brain/tree", body=body))
