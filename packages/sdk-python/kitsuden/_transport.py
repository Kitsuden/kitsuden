"""
Transport core, shared by the sync and the async client.

WHY THIS LAYER EXISTS

The SDK offers KitsudenClient (sync) and AsyncKitsudenClient (async). If both
build requests and handle errors on their own, the SDKs drift apart silently:
a fix reaches one half and not the other. Everything that does NOT depend on
the execution model lives here as pure functions: building the request and
interpreting the response. The clients only add the I/O.

It is the twin of `HttpClient` in packages/sdk/src/index.ts: same paths, same
headers, same error envelope. If you change one, change the other.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, Optional
from urllib.parse import urlencode

import httpx

from ._toon import decode_toon

TOON_MIME = "application/vnd.toon"
# `auto`: the API sends compact JSON or TOON, the shortest one that gives back the
# same data (not TRON: this SDK does not decode it).
AUTO_ACCEPT = 'application/vnd.kitsuden.auto; formats="json,toon"'


class KitsudenError(Exception):
    """Error returned by the Kitsuden API.

    It keeps the HTTP ``status`` and the raw payload so the caller can tell a
    404 (does not exist) from a 403 (not allowed) without parsing messages.
    """

    def __init__(self, message: str, status: int, payload: Optional[Any] = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


@dataclass(frozen=True)
class Request:
    """A fully built request, ready for the client's I/O."""

    method: str
    url: str
    headers: dict
    body: Optional[bytes]


def build_request(
    base_url: str,
    api_key: Optional[str],
    fmt: str,
    method: str,
    path: str,
    body: Optional[Any] = None,
    params: Optional[Mapping[str, Any]] = None,
    override_format: Optional[str] = None,
) -> Request:
    """Build the request with the same rules as the TS SDK.

    - WRITES always go as JSON (TOON is a response format, not a request one).
    - TOON is requested with ``?format=toon`` plus an Accept header, like the TS SDK.
    - ``auto`` is requested with the Accept header only: the API picks per response.
    """
    active_format = override_format or fmt
    if method != "GET":
        # Same as in TS: writes always negotiate JSON.
        active_format = "json"

    query: dict = {}
    if params:
        # None means "do not send the parameter", not "send null".
        query.update({k: v for k, v in params.items() if v is not None})
    if active_format == "toon":
        query["format"] = "toon"

    url = f"{base_url.rstrip('/')}/api{path}"
    if query:
        url += ("&" if "?" in url else "?") + urlencode(query)

    headers = {"Content-Type": "application/json"}
    if active_format == "toon":
        headers["Accept"] = TOON_MIME
    elif active_format == "auto":
        headers["Accept"] = AUTO_ACCEPT
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    raw = json.dumps(body).encode("utf-8") if body is not None else None
    return Request(method=method, url=url, headers=headers, body=raw)


def interpret_response(response: httpx.Response) -> Any:
    """Turn the HTTP response into data or a KitsudenError.

    Same contract as the TS SDK: on error it tries to read the ``{error}`` /
    ``{message}`` envelope; on 204 it returns None; TOON is parsed when the
    Content-Type declares it.
    """
    if response.status_code >= 400:
        message = f"Request failed: {response.status_code}"
        payload = None
        try:
            payload = response.json()
            if isinstance(payload, dict):
                err = payload.get("error") or payload.get("message")
                if isinstance(err, dict):
                    err = err.get("message") or json.dumps(err)
                if err:
                    message = str(err)
        except Exception:
            # Non-JSON body (proxy, error HTML): the status is the datum.
            pass
        raise KitsudenError(message, response.status_code, payload)

    if response.status_code == 204 or not response.content:
        return None

    content_type = response.headers.get("content-type", "")
    if TOON_MIME in content_type:
        return decode_toon(response.text)

    return response.json()


# ── TOON ─────────────────────────────────────────────────────────────────────
# The decoder lives in _toon.py (port of the API's). `parse_toon` is kept
# as a public name: it used to be a parser for a `key:value` + `---` format
# that the API no longer writes and that returned empty or malformed data.


def parse_toon(text: str):
    """Decode TOON (alias of :func:`kitsuden._toon.decode_toon`)."""
    return decode_toon(text)
