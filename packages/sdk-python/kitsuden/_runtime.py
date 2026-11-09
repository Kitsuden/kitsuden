"""
Runtime of the typed client, shared by the sync and the async client.

Everything that does not depend on the execution model (URL, headers, retry
decision, decoding) is a pure function here; the clients only add the I/O.
It is the twin of ``packages/sdk/src/api/transport.ts``: same headers, same
retry rules, same outcome shapes. Change one, change the other.

Why dataclasses (and not pydantic): the SDK's own values (``Ok``,
``ProposalPending``, ``ResponseMeta``, ``OperationInfo``…) are small frozen
dataclasses from the standard library, and the request/response bodies are
``TypedDict``s generated from the OpenAPI document. That keeps ``httpx`` as the
only dependency (no pydantic v1/v2 conflict in the user's project), costs
nothing at runtime (a response is the ``dict`` the API sent, unknown fields
included), and still gives editors and type checkers every field.
"""

from __future__ import annotations

import email.utils
import json
import random as _random
import re
import secrets
import time
from dataclasses import dataclass, field, replace
from typing import (
    TYPE_CHECKING,
    Any,
    Awaitable,
    Callable,
    Dict,
    Generic,
    List,
    Literal,
    Mapping,
    Optional,
    Tuple,
    TypeVar,
    Union,
)

from typing import TypedDict

import httpx

from ._toon import decode_toon
from ._tron import decode_tron
from ._transport import KitsudenError

if TYPE_CHECKING:  # pragma: no cover
    from ._generated import KitsudenErrorCode

T = TypeVar("T")

Format = Literal["json", "toon", "tron", "auto"]
ResponseKind = Literal["json", "text", "binary", "empty", "redirect"]

MIME: Dict[str, str] = {
    "json": "application/json",
    "toon": "application/vnd.toon",
    "tron": "application/vnd.tron",
    "auto": "application/vnd.kitsuden.auto",
}

_RETRYABLE_WITHOUT_PROBLEM = frozenset({408, 429, 502, 503, 504})


# ── Types ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PaginationInfo:
    style: Literal["page", "offset", "cursor"]
    #: Field with the items ("" = the response is the list; None = guess).
    items: Optional[str]
    #: Query parameter that sets the page size, if any.
    limit: Optional[str] = None


@dataclass(frozen=True)
class OperationInfo:
    """Runtime description of one operation, generated from its OpenAPI entry."""

    kon: str
    id: str
    operation_id: str
    method: str
    #: Path under ``/api`` with ``{param}`` placeholders.
    path: str
    path_params: Tuple[str, ...] = ()
    query_params: Tuple[str, ...] = ()
    body: Optional[str] = None
    responses: Mapping[int, str] = field(default_factory=dict)
    idempotent: bool = False
    read_only: bool = False
    #: May be held for human approval (202 KITSUDEN_E_APPROVAL_REQUIRED).
    sensitive: bool = False
    scope: Optional[str] = None
    mcp_tool: Optional[str] = None
    errors: Tuple[str, ...] = ()
    pagination: Optional[PaginationInfo] = None


class _ProblemRequired(TypedDict):
    type: str
    title: str
    status: int
    detail: str
    code: str
    retryable: bool
    retry_after: Optional[int]
    hint: str
    docs: str


class Problem(_ProblemRequired, total=False):
    """RFC 9457 problem details. Branch on ``code`` (a ``KitsudenErrorCode``), never on ``detail``."""

    instance: str
    requestId: Optional[str]
    error: Any


class _ProposalRequired(TypedDict):
    id: str
    status: str
    statusUrl: str


class Proposal(_ProposalRequired, total=False):
    """A request held for human approval. Poll ``statusUrl`` (GET, same credentials)."""

    reason: Optional[str]
    channel: Optional[str]
    method: Optional[str]
    path: Optional[str]
    tool: Optional[str]
    operation: Optional[str]
    createdAt: Optional[str]
    expiresAt: Optional[str]
    decidedAt: Optional[str]
    comment: Optional[str]
    executedAt: Optional[str]
    result: Dict[str, Any]


class RecordProvenance(TypedDict, total=False):
    id: Optional[str]
    author: str
    untrusted: bool
    self: bool


class RedirectResult(TypedDict):
    status: int
    location: Optional[str]


@dataclass(frozen=True)
class ProvenanceSummary:
    """``X-Kitsuden-Provenance`` response header: who wrote the rows."""

    untrusted: int
    authors: Mapping[str, int]
    raw: str


@dataclass(frozen=True)
class ResponseMeta:
    status: int
    headers: httpx.Headers
    request_id: Optional[str]
    #: Format the body came in (``X-Kitsuden-Format``), or None.
    format: Optional[str]
    content_type: Optional[str]
    provenance: Optional[ProvenanceSummary]
    #: The Idempotency-Key sent (the same one on every retry), or None.
    idempotency_key: Optional[str]
    #: The server replayed the first response (``Idempotent-Replayed: true``).
    replayed: bool
    attempts: int
    operation: Optional[OperationInfo]


@dataclass(frozen=True)
class Ok(Generic[T]):
    data: T
    status: int
    meta: ResponseMeta
    kind: Literal["ok"] = "ok"
    ok: Literal[True] = True


@dataclass(frozen=True)
class ProposalPending:
    """Nothing ran: the request is a proposal waiting for a human.

    Do NOT resend it. Report ``proposal["id"]`` and poll ``proposal["statusUrl"]``
    (or the MCP tool ``kitsuden_proposal_status``) if the result is needed.
    """

    proposal: Proposal
    problem: Problem
    meta: ResponseMeta
    status: Literal[202] = 202
    kind: Literal["proposal_pending"] = "proposal_pending"
    ok: Literal[False] = False


Outcome = Union[Ok[T], ProposalPending]


@dataclass(frozen=True)
class RetryPolicy:
    #: Retries after the first attempt. 0 disables retrying.
    max_retries: int = 2
    #: First backoff (seconds) without ``Retry-After``; doubles, full jitter.
    base_delay: float = 0.25
    max_delay: float = 8.0
    #: A ``Retry-After`` longer than this is not waited for: the error is raised.
    max_retry_after: float = 60.0


@dataclass(frozen=True)
class RequestOptions:
    """Per-call options (``request_options=`` on every generated method)."""

    #: Writes get a fresh key per call (kept across its retries). A string to
    #: make a later call replay this one; False to send none.
    idempotency_key: Union[str, bool, None] = None
    format: Optional[Format] = None
    #: Ask who wrote each row: ``meta.provenance`` and ``row["_provenance"]``.
    provenance: Optional[bool] = None
    untrusted_wrap: Optional[Literal["none", "delimiters", "object"]] = None
    headers: Optional[Mapping[str, str]] = None
    #: Seconds per attempt.
    timeout: Optional[float] = None
    retry: Union[RetryPolicy, Literal[False], None] = None


# ── Errors ───────────────────────────────────────────────────────────────────


class KitsudenApiError(KitsudenError):
    """An ``/api/*`` error response (problem+json). Branch on ``code``."""

    def __init__(self, problem: Problem, meta: ResponseMeta, retry_after: Optional[float]):
        detail = problem.get("detail") or problem.get("title") or ""
        hint = problem.get("hint") or ""
        super().__init__(
            f"{problem.get('code')}: {detail}" + (f" ({hint})" if hint else ""),
            meta.status,
            problem,
        )
        self.problem: Problem = problem
        self.code: str = str(problem.get("code"))
        self.retryable: bool = problem.get("retryable") is True
        self.retry_after: Optional[float] = retry_after
        self.request_id: Optional[str] = meta.request_id or problem.get("requestId")
        self.meta = meta


class KitsudenNetworkError(KitsudenError):
    """No HTTP response (DNS, refused connection, timeout)."""

    def __init__(self, message: str, operation: Optional[OperationInfo], attempts: int, timed_out: bool):
        super().__init__(message, 0, None)
        self.operation = operation
        self.attempts = attempts
        self.timed_out = timed_out


class KitsudenDecodeError(KitsudenError):
    """A success body that could not be decoded in the format it declared."""

    def __init__(self, message: str, meta: ResponseMeta):
        super().__init__(message, meta.status, None)
        self.meta = meta


class ProposalPendingError(KitsudenError):
    """Raised only where a pending proposal cannot be returned (iterators, ``expect_ok``)."""

    def __init__(self, pending: ProposalPending):
        super().__init__(
            f"{pending.problem.get('code')}: proposal {pending.proposal.get('id')} is waiting for human "
            f"approval; nothing ran. Do not resend it; poll {pending.proposal.get('statusUrl')}.",
            202,
            pending.problem,
        )
        self.pending = pending


def expect_ok(outcome: "Outcome[T]") -> T:
    """The data of an ``Ok``; raises ``ProposalPendingError`` for a pending proposal."""
    if isinstance(outcome, Ok):
        return outcome.data
    raise ProposalPendingError(outcome)


def provenance_of(row: Any) -> Optional[RecordProvenance]:
    """Who wrote this row (present when the call asked for provenance)."""
    p = row.get("_provenance") if isinstance(row, dict) else None
    return p if isinstance(p, dict) else None  # type: ignore[return-value]


# ── Pure pieces ──────────────────────────────────────────────────────────────


def random_idempotency_key() -> str:
    return f"ksdk-{secrets.token_hex(16)}"


def normalize_base_url(url: str) -> str:
    u = url.strip().rstrip("/")
    return u[:-4] if u.endswith("/api") else u


def _text(v: Any) -> str:
    if isinstance(v, str):
        return v
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def build_url(base_url: str, info: OperationInfo, params: Mapping[str, Any]) -> str:
    from urllib.parse import quote, urlencode

    path = info.path
    for name in info.path_params:
        v = params.get(name)
        if v is None or v == "":
            raise TypeError(f"{info.operation_id}: missing path parameter {name!r}")
        path = path.replace("{" + name + "}", quote(_text(v), safe=""))
    q = [(n, _text(params[n])) for n in info.query_params if params.get(n) is not None]
    qs = urlencode(q)
    return f"{base_url}/api{'' if path == '/' else path}" + (f"?{qs}" if qs else "")


def parse_provenance(raw: Optional[str]) -> Optional[ProvenanceSummary]:
    if not raw:
        return None
    untrusted = 0
    authors: Dict[str, int] = {}
    for part in raw.split(";"):
        if "=" not in part:
            continue
        k, v = (s.strip() for s in part.split("=", 1))
        try:
            n = int(float(v))
        except ValueError:
            continue
        if k == "untrusted":
            untrusted = n
        else:
            authors[k] = n
    return ProvenanceSummary(untrusted=untrusted, authors=authors, raw=raw)


def parse_retry_after(v: Optional[str], now: Optional[float] = None) -> Optional[float]:
    if not v:
        return None
    s = v.strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return float(s)
    try:
        date = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        return None
    if date is None:
        return None
    return max(0.0, date.timestamp() - (time.time() if now is None else now))


def _format_of(content_type: Optional[str], header: Optional[str]) -> Optional[str]:
    f = (header or "").strip().lower()
    if f in ("json", "toon", "tron"):
        return f
    ct = (content_type or "").lower()
    if MIME["toon"] in ct:
        return "toon"
    if MIME["tron"] in ct:
        return "tron"
    if "json" in ct:
        return "json"
    return None


def decode_body(text: str, fmt: Optional[str]) -> Any:
    """Decode a text body in the format it declared."""
    if fmt == "toon":
        return decode_toon(text)
    if fmt == "tron":
        return decode_tron(text)
    return None if text == "" else json.loads(text)


def _problem_of(status: int, body: Any, reason: str) -> Problem:
    if isinstance(body, dict) and isinstance(body.get("code"), str):
        p = dict(body)
        if not isinstance(p.get("status"), int):
            p["status"] = status
        return p  # type: ignore[return-value]
    if isinstance(body, dict) and "error" in body:
        detail = _text(body["error"])
    elif isinstance(body, str) and body:
        detail = body[:500]
    else:
        detail = reason or f"HTTP {status}"
    code = "KITSUDEN_E_INTERNAL" if status >= 500 else "KITSUDEN_E_NOT_FOUND" if status == 404 else "KITSUDEN_E_BAD_REQUEST"
    return {  # type: ignore[return-value]
        "type": "about:blank",
        "title": reason or f"HTTP {status}",
        "status": status,
        "detail": detail,
        "code": code,
        "retryable": status in _RETRYABLE_WITHOUT_PROBLEM,
        "retry_after": None,
        "hint": "",
        "docs": "",
        "error": body,
    }


def _safe_json(t: str) -> Any:
    try:
        return json.loads(t)
    except ValueError:
        return t


@dataclass
class Config:
    base_url: str
    token: Optional[str]
    session_cookie: Optional[str]
    format: Format
    provenance: bool
    untrusted_wrap: Optional[str]
    headers: Dict[str, str]
    timeout: float
    retry: RetryPolicy
    new_idempotency_key: Callable[[], str] = random_idempotency_key
    random: Callable[[], float] = _random.random


@dataclass
class Prepared:
    """Everything one call needs, computed once (and reused on every retry)."""

    info: OperationInfo
    method: str
    url: str
    headers: Dict[str, str]
    content: Optional[bytes]
    files: Any
    data: Any
    key: Optional[str]
    safe: bool
    policy: RetryPolicy
    timeout: float
    follow_redirects: bool


def prepare(cfg: Config, info: OperationInfo, params: Mapping[str, Any], body: Any, opts: Optional[RequestOptions]) -> Prepared:
    o = opts or RequestOptions()
    if o.retry is False:
        policy = replace(cfg.retry, max_retries=0)
    elif isinstance(o.retry, RetryPolicy):
        policy = o.retry
    else:
        policy = cfg.retry
    fmt = o.format or cfg.format
    url = build_url(cfg.base_url, info, params)
    write = info.method != "GET"
    headers: Dict[str, str] = {"accept": MIME[fmt], **cfg.headers}
    if cfg.token:
        headers["authorization"] = f"Bearer {cfg.token}"
    if cfg.session_cookie:
        headers["cookie"] = cfg.session_cookie
    if o.provenance if o.provenance is not None else cfg.provenance:
        headers["x-kitsuden-provenance"] = "1"
    wrap = o.untrusted_wrap or cfg.untrusted_wrap
    if wrap:
        headers["x-kitsuden-untrusted-wrap"] = wrap
    content: Optional[bytes] = None
    files = None
    data = None
    if body is not None and info.body is not None:
        if info.body == "multipart":
            # {"field": value} or {"file": (name, bytes, content_type)}: httpx builds the form.
            files = {k: v for k, v in body.items() if isinstance(v, tuple)}
            data = {k: v for k, v in body.items() if not isinstance(v, tuple)}
        else:
            headers["content-type"] = "application/json"
            content = json.dumps(body, ensure_ascii=False).encode("utf-8")
    key: Optional[str] = None
    if write and o.idempotency_key is not False:
        key = o.idempotency_key if isinstance(o.idempotency_key, str) else cfg.new_idempotency_key()
        headers["idempotency-key"] = key
    headers.update(dict(o.headers or {}))
    safe = (not write) or info.idempotent or info.read_only or key is not None
    return Prepared(
        info=info,
        method=info.method,
        url=url,
        headers=headers,
        content=content,
        files=files or None,
        data=data or None,
        key=key,
        safe=safe,
        policy=policy,
        timeout=o.timeout if o.timeout is not None else cfg.timeout,
        follow_redirects=False,
    )


def backoff(attempt: int, policy: RetryPolicy, rnd: Callable[[], float]) -> float:
    return rnd() * min(policy.max_delay, policy.base_delay * (2**attempt))


def meta_of(res: httpx.Response, prep: Prepared, attempts: int) -> ResponseMeta:
    ct = res.headers.get("content-type")
    return ResponseMeta(
        status=res.status_code,
        headers=res.headers,
        request_id=res.headers.get("x-request-id"),
        format=_format_of(ct, res.headers.get("x-kitsuden-format")),
        content_type=ct,
        provenance=parse_provenance(res.headers.get("x-kitsuden-provenance")),
        idempotency_key=prep.key,
        replayed=(res.headers.get("idempotent-replayed") or "").lower() == "true",
        attempts=attempts,
        operation=prep.info,
    )


#: What to do with a response: ("done", outcome) | ("retry", seconds) | ("raise", error)
Decision = Tuple[str, Any]


def decide(res: httpx.Response, prep: Prepared, attempt: int, cfg: Config) -> Decision:
    """The whole response policy, shared by sync and async (the body is already read)."""
    meta = meta_of(res, prep, attempt + 1)
    ct = (meta.content_type or "").lower()
    # 202 pending approval: recognized by its `code`, not by the media type (the
    # API has sent it as problem+json and as plain json; with format=toon/tron
    # it may come in that format).
    if res.status_code == 202 and (meta.format is not None or "json" in ct):
        try:
            p = decode_body(res.text, "json" if "problem+json" in ct else meta.format)
        except Exception:  # noqa: BLE001
            p = res.text
        if isinstance(p, dict) and p.get("code") == "KITSUDEN_E_APPROVAL_REQUIRED":
            return ("done", ProposalPending(proposal=p.get("proposal") or {}, problem=p, meta=meta))  # type: ignore[arg-type]
        return ("done", Ok(data=p, status=202, meta=meta))
    redirect = "redirect" in prep.info.responses.values()
    if res.status_code >= 400 or (300 <= res.status_code < 400 and not redirect):
        problem = _problem_of(res.status_code, _safe_json(res.text), res.reason_phrase)
        header = parse_retry_after(res.headers.get("retry-after"))
        ra = problem.get("retry_after")
        wait = header if header is not None else (float(ra) if isinstance(ra, (int, float)) else None)
        if problem.get("retryable") is True and prep.safe and attempt < prep.policy.max_retries:
            s = wait if wait is not None else backoff(attempt, prep.policy, cfg.random)
            if s <= prep.policy.max_retry_after:
                return ("retry", s)
        return ("raise", KitsudenApiError(problem, meta, wait))
    kind = prep.info.responses.get(res.status_code)
    if kind == "redirect" or 300 <= res.status_code < 400:
        return ("done", Ok(data={"status": res.status_code, "location": res.headers.get("location")}, status=res.status_code, meta=meta))
    if res.status_code == 204 or kind == "empty":
        return ("done", Ok(data=None, status=res.status_code, meta=meta))
    is_text = meta.format is not None or ct.startswith("text/") or "javascript" in ct
    if kind == "binary" or (not is_text and kind not in ("json", "text")):
        return ("done", Ok(data=res.content, status=res.status_code, meta=meta))
    if kind == "text" or (meta.format is None and "json" not in ct):
        return ("done", Ok(data=res.text, status=res.status_code, meta=meta))
    try:
        data = decode_body(res.text, meta.format)
    except Exception as err:  # noqa: BLE001 - any decoder failure is a decode error
        e = KitsudenDecodeError(f"{prep.info.operation_id}: could not decode the {meta.format or 'json'} body: {err}", meta)
        return ("raise", e)
    return ("done", Ok(data=data, status=res.status_code, meta=meta))


def network_decision(err: Exception, prep: Prepared, attempt: int, cfg: Config) -> Decision:
    if prep.safe and attempt < prep.policy.max_retries:
        return ("retry", backoff(attempt, prep.policy, cfg.random))
    timed_out = isinstance(err, httpx.TimeoutException)
    msg = f"{prep.method} {prep.url}: " + (f"no response in {prep.timeout} s" if timed_out else str(err) or type(err).__name__)
    return ("raise", KitsudenNetworkError(msg, prep.info, attempt + 1, timed_out))


def raw_info(method: str, path: str, query: Optional[Mapping[str, Any]], has_body: bool, body_format: str) -> OperationInfo:
    clean = path if path.startswith("/") else f"/{path}"
    return OperationInfo(
        kon="",
        id="",
        operation_id=f"{method} {clean}",
        method=method,
        path=clean,
        query_params=tuple((query or {}).keys()),
        body=body_format if has_body else None,
        idempotent=method in ("GET", "PUT", "DELETE"),
        read_only=method == "GET",
    )


# ── Pagination (pure step) ───────────────────────────────────────────────────

_ITEM_FIELDS = ("docs", "data", "items", "rows", "results", "entries")
_CONTAINERS = ("", "pagination", "meta", "pageInfo")


def items_of(data: Any, field_name: Optional[str]) -> List[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    if field_name:
        v = data.get(field_name)
        return v if isinstance(v, list) else []
    for k in _ITEM_FIELDS:
        if isinstance(data.get(k), list):
            return data[k]
    lists = [v for v in data.values() if isinstance(v, list)]
    return lists[0] if len(lists) == 1 else []


def _find(data: Any, names: Tuple[str, ...]) -> Any:
    if not isinstance(data, dict):
        return None
    for c in _CONTAINERS:
        where = data if c == "" else data.get(c)
        if not isinstance(where, dict):
            continue
        for n in names:
            if where.get(n) is not None:
                return where[n]
    return None


def _number(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


class PageWalker:
    """The pagination state machine, shared by the sync and async iterators."""

    def __init__(self, info: OperationInfo, params: Mapping[str, Any]):
        if info.pagination is None:
            raise TypeError(f"{info.operation_id} is not a list operation")
        self.info = info
        self.paging = info.pagination
        self.params: Dict[str, Any] = {k: v for k, v in params.items() if v is not None}
        self.page = int(_number(self.params.get("page")) or 1)
        self.offset = int(_number(self.params.get("offset")) or 0)
        self.done = False

    def next_params(self) -> Dict[str, Any]:
        if self.paging.style == "page":
            self.params["page"] = self.page
        elif self.paging.style == "offset":
            self.params["offset"] = self.offset
        return dict(self.params)

    def advance(self, data: Any) -> List[Any]:
        """Items of this page; sets ``done`` when there is no next one."""
        items = items_of(data, self.paging.items)
        if not items:
            self.done = True
            return items
        has_more = _find(data, ("hasNextPage", "hasMore", "has_more", "hasNext"))
        if has_more is False:
            self.done = True
            return items
        limit = _number(self.params.get(self.paging.limit)) if self.paging.limit else None
        if limit is None:
            limit = _number(_find(data, ("limit", "pageSize", "perPage")))
        short = has_more is not True and limit is not None and len(items) < limit
        if self.paging.style == "cursor":
            next_cursor = _find(data, ("nextCursor", "next_cursor", "cursor"))
            if next_cursor in (None, "") or next_cursor == self.params.get("cursor"):
                self.done = True
            else:
                self.params["cursor"] = next_cursor
            return items
        if short:
            self.done = True
            return items
        if self.paging.style == "page":
            total_pages = _number(_find(data, ("totalPages", "pages", "pageCount")))
            if total_pages is not None and self.page >= total_pages:
                self.done = True
            self.page += 1
        else:
            self.offset += len(items)
            total = _number(_find(data, ("totalDocs", "total", "totalCount", "count")))
            if total is not None and self.offset >= total:
                self.done = True
        return items


# ── Base classes of the generated kon groups ─────────────────────────────────


class KonApi:
    """Base of every generated sync kon group (``client.blog``, ``client.wiki``…)."""

    kon: str = ""

    def __init__(self, client: Any):
        self._client = client

    def _call(self, info: OperationInfo, params: Mapping[str, Any], body: Any, options: Optional[RequestOptions]) -> Any:
        return self._client._execute(info, params, body, options)

    def _iterate(self, info: OperationInfo, params: Mapping[str, Any], options: Optional[RequestOptions]) -> Any:
        walker = PageWalker(info, params)
        while not walker.done:
            out = self._client._execute(info, walker.next_params(), None, options)
            if not isinstance(out, Ok):
                raise ProposalPendingError(out)
            for item in walker.advance(out.data):
                yield item

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.kon}>"


class AsyncKonApi:
    """Base of every generated async kon group."""

    kon: str = ""

    def __init__(self, client: Any):
        self._client = client

    async def _call(self, info: OperationInfo, params: Mapping[str, Any], body: Any, options: Optional[RequestOptions]) -> Any:
        return await self._client._execute(info, params, body, options)

    async def _iterate(self, info: OperationInfo, params: Mapping[str, Any], options: Optional[RequestOptions]) -> Any:
        walker = PageWalker(info, params)
        while not walker.done:
            out = await self._client._execute(info, walker.next_params(), None, options)
            if not isinstance(out, Ok):
                raise ProposalPendingError(out)
            for item in walker.advance(out.data):
                yield item

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.kon}>"


Sleep = Callable[[float], None]
AsyncSleep = Callable[[float], Awaitable[None]]
