"""kitsuden: the official Python client for Kitsuden.

The Supabase model: the backend speaks API, the clients speak your language.
"""

from typing import Any, Optional

from ._toon import ToonDecodeError, decode_toon
from ._transport import KitsudenError, parse_toon
from .client import (
    AsyncKitsudenClient,
    ListResponse,
    Pagination,
    KitsudenClient,
)

# Typed client generated from the API's OpenAPI 3.1 (pnpm sdk:generate).
from ._generated import API_VERSION, ERROR_CODES, KitsudenErrorCode
from ._runtime import (
    KitsudenApiError,
    KitsudenDecodeError,
    KitsudenNetworkError,
    Ok,
    OperationInfo,
    Outcome,
    PaginationInfo,
    Problem,
    Proposal,
    ProposalPending,
    ProposalPendingError,
    ProvenanceSummary,
    RecordProvenance,
    RedirectResult,
    RequestOptions,
    ResponseMeta,
    RetryPolicy,
    decode_body,
    expect_ok,
    parse_provenance,
    parse_retry_after,
    provenance_of,
)
from ._tron import TronDecodeError, decode_tron
from .api import AsyncKitsudenApi, KitsudenApi, create_kitsuden

__version__ = "0.9.0b0"

__all__ = [
    "KitsudenApi",
    "AsyncKitsudenApi",
    "create_kitsuden",
    "KitsudenApiError",
    "KitsudenNetworkError",
    "KitsudenDecodeError",
    "ProposalPendingError",
    "Ok",
    "ProposalPending",
    "Outcome",
    "Problem",
    "Proposal",
    "RequestOptions",
    "RetryPolicy",
    "ResponseMeta",
    "ProvenanceSummary",
    "RecordProvenance",
    "RedirectResult",
    "OperationInfo",
    "PaginationInfo",
    "KitsudenErrorCode",
    "ERROR_CODES",
    "API_VERSION",
    "expect_ok",
    "provenance_of",
    "parse_provenance",
    "parse_retry_after",
    "decode_body",
    "decode_tron",
    "TronDecodeError",
    "KitsudenClient",
    "AsyncKitsudenClient",
    "KitsudenError",
    "ListResponse",
    "Pagination",
    "parse_toon",
    "decode_toon",
    "ToonDecodeError",
    "create_client",
]


def create_client(url: str, api_key: Optional[str] = None, **kwargs: Any) -> KitsudenClient:
    """Familiar shorthand for anyone coming from supabase-py."""
    return KitsudenClient(url, api_key=api_key, **kwargs)
