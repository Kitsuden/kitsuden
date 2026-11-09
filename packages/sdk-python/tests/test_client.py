"""
Tests for the Python SDK: no network and no server.

`httpx.MockTransport` intercepts every request and returns canned responses.
What is checked is the CONTRACT with the API: exact paths, headers, body,
error envelope and parsing, which is where an SDK really breaks. The server
logic has its own tests in the monorepo.
"""

import json
import unittest
from pathlib import Path

import httpx

from kitsuden import (
    AsyncKitsudenClient,
    KitsudenClient,
    KitsudenError,
    ToonDecodeError,
    decode_toon,
    parse_toon,
)

BASE = "http://kitsuden.test"


def make_client(handler, **kwargs) -> KitsudenClient:
    return KitsudenClient(
        BASE, api_key="kitsuden_sk_test", transport=httpx.MockTransport(handler), **kwargs
    )


class Capture:
    """Keeps the last request and answers with what was configured."""

    def __init__(self, status=200, payload=None, headers=None):
        self.status = status
        self.payload = payload if payload is not None else {}
        self.headers = headers or {}
        self.last: httpx.Request = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.last = request
        body = (
            self.payload
            if isinstance(self.payload, (str, bytes))
            else json.dumps(self.payload)
        )
        return httpx.Response(self.status, content=body, headers=self.headers)


class TestPathsAndHeaders(unittest.TestCase):
    """The literal contract with the API: same paths as the TS SDK."""

    def test_table_list_path_and_auth(self):
        cap = Capture(payload={"data": [], "pagination": None})
        with make_client(cap) as client:
            client.table("notes").list(limit=5, page=2)

        self.assertEqual(cap.last.url.path, "/api/explorer/notes")
        self.assertIn("limit=5", str(cap.last.url))
        self.assertIn("page=2", str(cap.last.url))
        # The API key travels as a Bearer, same as in TS.
        self.assertEqual(cap.last.headers["authorization"], "Bearer kitsuden_sk_test")

    def test_full_crud_uses_the_right_verbs(self):
        cap = Capture(payload={"id": "1"})
        with make_client(cap) as client:
            table = client.table("notes")

            table.create({"title": "Elden Ring"})
            self.assertEqual((cap.last.method, cap.last.url.path), ("POST", "/api/explorer/notes"))
            self.assertEqual(json.loads(cap.last.content), {"title": "Elden Ring"})

            table.update("42", {"title": "DLC"})
            self.assertEqual(
                (cap.last.method, cap.last.url.path), ("PATCH", "/api/explorer/notes/42")
            )

            table.delete("42")
            self.assertEqual(
                (cap.last.method, cap.last.url.path), ("DELETE", "/api/explorer/notes/42")
            )

    def test_collection_reads_and_writes_on_different_paths(self):
        # The API's current contract: reads and writes differ. The SDK
        # must reproduce it, not "fix" it.
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            col = client.collection("mmorpg-builds")

            col.entries(limit=3)
            self.assertEqual(cap.last.url.path, "/api/datasets/mmorpg-builds/entries")

            col.insert({"name": "necro"})
            self.assertEqual(cap.last.url.path, "/api/datasets/slug/mmorpg-builds/entries")

    def test_vector_search_and_tree(self):
        cap = Capture(payload={"results": []})
        with make_client(cap) as client:
            client.vector_search("ds1", "necromancer builds", limit=5, threshold=0.7)
            self.assertEqual(cap.last.url.path, "/api/datasets/ds1/vector-search")
            body = json.loads(cap.last.content)
            self.assertEqual(body["query"], "necromancer builds")
            self.assertEqual(body["threshold"], 0.7)

            client.tree_retrieve("# Doc\n## A", "what is in A", sections=["a"])
            self.assertEqual(cap.last.url.path, "/api/brain/tree/retrieve")
            self.assertEqual(json.loads(cap.last.content)["sections"], ["a"])

    def test_no_api_key_means_no_authorization_header(self):
        cap = Capture(payload={})
        with KitsudenClient(BASE, transport=httpx.MockTransport(cap)) as client:
            client.table("notes").options()
        self.assertNotIn("authorization", cap.last.headers)


class TestToon(unittest.TestCase):
    def test_toon_negotiates_with_query_and_accept(self):
        cap = Capture(payload={"data": []})
        with make_client(cap, format="toon") as client:
            client.table("notes").list()

        self.assertIn("format=toon", str(cap.last.url))
        self.assertEqual(cap.last.headers["accept"], "application/vnd.toon")

    def test_writes_always_json_even_if_the_client_is_toon(self):
        # TOON is a RESPONSE format. Sending writes in TOON would break the
        # server; the TS SDK forces JSON on writes and this one does the same.
        cap = Capture(payload={})
        with make_client(cap, format="toon") as client:
            client.table("notes").create({"a": 1})

        self.assertNotIn("format=toon", str(cap.last.url))
        self.assertEqual(cap.last.headers["content-type"], "application/json")

    def test_parses_toon_response(self):
        # Real TOON, as the API writes it: a table with the keys once.
        toon = "[2]{id,title,active}:\n  1,Elden Ring,true\n  2,DS3,false"
        cap = Capture(payload=toon, headers={"content-type": "application/vnd.toon"})
        with make_client(cap, format="toon") as client:
            rows = client.table("notes").get("whatever")

        self.assertEqual(rows[0]["title"], "Elden Ring")
        self.assertIs(rows[0]["active"], True)
        self.assertIs(rows[1]["active"], False)

    def test_auto_negotiates_only_with_accept(self):
        cap = Capture(payload={"data": []})
        with make_client(cap, format="auto") as client:
            client.table("notes").list()

        self.assertNotIn("format=", str(cap.last.url))
        self.assertEqual(
            cap.last.headers["accept"], 'application/vnd.kitsuden.auto; formats="json,toon"'
        )

    def test_auto_reads_json_or_toon_by_content_type(self):
        for body, kind_of in (
            ('{"a":[1,2]}', "application/json"),
            ("a[2]: 1,2", "application/vnd.toon"),
        ):
            cap = Capture(payload=body, headers={"content-type": kind_of})
            with make_client(cap, format="auto") as client:
                self.assertEqual(client.table("x").get("1"), {"a": [1, 2]})

    def test_malformed_toon_raises(self):
        with self.assertRaises(ToonDecodeError):
            decode_toon("a[3]{x}:\n  1\n  2")

    def test_cases_shared_with_the_api(self):
        # TOON -> JSON pairs written by the API's encoder (an API
        # test checks that the file stays up to date).
        route = Path(__file__).parent / "fixtures" / "toon-cases.json"
        cases = json.loads(route.read_text(encoding="utf-8"))
        self.assertGreater(len(cases), 10)
        for case in cases:
            with self.subTest(case["name"]):
                self.assertEqual(decode_toon(case["toon"]), case["json"])
                self.assertEqual(parse_toon(case["toon"]), case["json"])


class TestErrors(unittest.TestCase):
    def test_error_envelope_keeps_status_and_message(self):
        cap = Capture(status=403, payload={"error": {"code": "FORBIDDEN", "message": "no"}})
        with make_client(cap) as client:
            with self.assertRaises(KitsudenError) as ctx:
                client.table("notes").get("1")

        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(str(ctx.exception), "no")
        # The raw payload stays available to decide programmatically.
        self.assertEqual(ctx.exception.payload["error"]["code"], "FORBIDDEN")

    def test_error_without_json_does_not_break_the_parser(self):
        cap = Capture(status=502, payload="<html>Bad Gateway</html>")
        with make_client(cap) as client:
            with self.assertRaises(KitsudenError) as ctx:
                client.table("x").get("1")
        self.assertEqual(ctx.exception.status, 502)

    def test_ping_does_not_raise(self):
        cap = Capture(status=500, payload={})
        with make_client(cap) as client:
            self.assertFalse(client.ping())

        ok = Capture(payload={"status": "ok"})
        with make_client(ok) as client:
            self.assertTrue(client.ping())


class TestListResponse(unittest.TestCase):
    def test_pagination_and_iteration(self):
        cap = Capture(
            payload={
                "data": [{"id": "1"}, {"id": "2"}],
                "pagination": {
                    "page": 1,
                    "limit": 2,
                    "total": 10,
                    "totalPages": 5,
                    "hasNextPage": True,
                    "hasPrevPage": False,
                },
            }
        )
        with make_client(cap) as client:
            page = client.table("notes").list(limit=2)

        self.assertEqual(len(page), 2)
        self.assertEqual([r["id"] for r in page], ["1", "2"])
        self.assertEqual(page.pagination.total, 10)
        self.assertTrue(page.pagination.has_next_page)


class TestAsyncClient(unittest.IsolatedAsyncioTestCase):
    """The async client shares request building with the sync one: it is enough
    to check that the contract is identical on a sample of operations."""

    async def test_same_contract_as_sync(self):
        cap = Capture(payload={"data": [{"id": "1"}], "pagination": None})
        async with AsyncKitsudenClient(
            BASE, api_key="kitsuden_sk_test", transport=httpx.MockTransport(cap)
        ) as client:
            page = await client.table("notes").list(limit=1)
            self.assertEqual(cap.last.url.path, "/api/explorer/notes")
            self.assertEqual(page.data[0]["id"], "1")

            await client.collection("builds").insert({"x": 1})
            self.assertEqual(cap.last.url.path, "/api/datasets/slug/builds/entries")

    async def test_error_async(self):
        cap = Capture(status=404, payload={"error": "Not found"})
        async with AsyncKitsudenClient(BASE, transport=httpx.MockTransport(cap)) as client:
            with self.assertRaises(KitsudenError) as ctx:
                await client.table("notes").get("nope")
        self.assertEqual(ctx.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
