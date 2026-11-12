"""
The explorer's list query (search, search_fields, filters) and the record history,
checked on the wire: what the server reads is the decoded query string, so the tests
compare `url.params.multi_items()`, which keeps repeated keys in order.

Server-side syntax: apps/api/src/lib/explorer-query.ts.
"""

import datetime as dt
import unittest

import httpx

from kitsuden import AsyncKitsudenClient

from test_client import BASE, Capture, make_client

HISTORY = {"history": [], "total": 0, "limit": 50, "offset": 0}


def pairs(request: httpx.Request) -> list:
    return list(request.url.params.multi_items())


class TestSearch(unittest.TestCase):
    def test_search_and_fields_as_list(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("games").list(search="zelda", search_fields=["title", "slug"])
        self.assertEqual(pairs(cap.last), [("search", "zelda"), ("search_fields", "title,slug")])

    def test_fields_as_string_and_empty_values_are_not_sent(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("games").list(search="a b", search_fields="title")
            self.assertEqual(pairs(cap.last), [("search", "a b"), ("search_fields", "title")])

            client.table("games").list(search="", search_fields=[])
            self.assertEqual(pairs(cap.last), [])


class TestFilters(unittest.TestCase):
    def test_equals_is_the_short_form(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("games").list(filters={"status": "draft"})
        self.assertEqual(pairs(cap.last), [("filter[status]", "draft")])
        # Brackets travel percent-encoded; the server decodes them.
        self.assertIn("filter%5Bstatus%5D=draft", str(cap.last.url))

    def test_each_operator(self):
        for op in ("contains", "equals", "gt", "lt", "gte", "lte"):
            with self.subTest(op):
                cap = Capture(payload={"data": []})
                with make_client(cap) as client:
                    client.table("games").list(filters={"title": {op: "x"}})
                self.assertEqual(pairs(cap.last), [(f"filter[title][{op}]", "x")])

    def test_several_conditions_on_one_column_are_all_sent(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("games").list(
                filters={"price": {"gte": 10, "lt": 20}, "status": "published"}
            )
        self.assertEqual(
            pairs(cap.last),
            [
                ("filter[price][gte]", "10"),
                ("filter[price][lt]", "20"),
                ("filter[status]", "published"),
            ],
        )

    def test_list_of_conditions(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("games").list(
                filters=[
                    {"field": "price", "op": "gte", "value": 10},
                    {"field": "price", "op": "lt", "value": 20},
                    {"field": "status", "value": "draft"},
                    {"field": "slug", "op": "equals", "value": "x"},
                ]
            )
        self.assertEqual(
            pairs(cap.last),
            [
                ("filter[price][gte]", "10"),
                ("filter[price][lt]", "20"),
                ("filter[status]", "draft"),
                ("filter[slug]", "x"),
            ],
        )

    def test_values_are_written_as_the_ts_sdk_writes_them(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("games").list(
                filters={
                    "active": True,
                    "archived": False,
                    "rating": {"gte": 4.5, "lt": 10.0},
                    "released_at": {"gte": dt.date(2020, 1, 31)},
                    "updated_at": {"lt": dt.datetime(2026, 1, 2, 3, 4, 5)},
                    "skipped": None,
                    "title": {"contains": None},
                }
            )
        self.assertEqual(
            pairs(cap.last),
            [
                ("filter[active]", "true"),
                ("filter[archived]", "false"),
                ("filter[rating][gte]", "4.5"),
                ("filter[rating][lt]", "10"),
                ("filter[released_at][gte]", "2020-01-31"),
                ("filter[updated_at][lt]", "2026-01-02T03:04:05"),
            ],
        )

    def test_unknown_operator_fails_before_the_request(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            for bad in ({"price": {"between": 1}}, [{"field": "price", "op": "ne", "value": 1}]):
                with self.subTest(bad=bad):
                    with self.assertRaises(ValueError) as ctx:
                        client.table("games").list(filters=bad)
                    self.assertIn("Unsupported filter operator", str(ctx.exception))
        self.assertIsNone(cap.last)

    def test_malformed_list_item_is_a_type_error(self):
        with make_client(Capture(payload={"data": []})) as client:
            with self.assertRaises(TypeError):
                client.table("games").list(filters=[{"op": "gt", "value": 1}])
            with self.assertRaises(TypeError):
                client.table("games").list(filters="status=draft")

    def test_old_single_filter_still_works_and_combines(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("users").list(
                limit=5,
                filter_field="email",
                filter_op="contains",
                filter_value="@x",
                filters={"role": "admin"},
            )
        self.assertEqual(
            pairs(cap.last),
            [
                ("limit", "5"),
                ("filter[role]", "admin"),
                ("filter_field", "email"),
                ("filter_op", "contains"),
                ("filter_value", "@x"),
            ],
        )

    def test_old_positional_order_is_kept(self):
        cap = Capture(payload={"data": []})
        with make_client(cap) as client:
            client.table("users").list(10, 2, "name", "asc", "email", "equals", "a@b.c")
        self.assertEqual(
            pairs(cap.last),
            [
                ("limit", "10"),
                ("page", "2"),
                ("sort", "name"),
                ("dir", "asc"),
                ("filter_field", "email"),
                ("filter_op", "equals"),
                ("filter_value", "a@b.c"),
            ],
        )

    def test_toon_format_param_is_kept_with_repeated_keys(self):
        cap = Capture(payload={"data": []})
        with make_client(cap, format="toon") as client:
            client.table("games").list(filters={"price": {"gt": 1, "lt": 9}})
        self.assertEqual(
            pairs(cap.last),
            [("filter[price][gt]", "1"), ("filter[price][lt]", "9"), ("format", "toon")],
        )


class TestHistory(unittest.TestCase):
    def test_path_and_paging(self):
        cap = Capture(payload=HISTORY)
        with make_client(cap) as client:
            result = client.table("games").history("uuid-1")
            self.assertEqual((cap.last.method, cap.last.url.path), ("GET", "/api/history/games/uuid-1"))
            self.assertEqual(pairs(cap.last), [])
            self.assertEqual(result, HISTORY)

            client.table("games").history("uuid-1", limit=10, offset=20)
            self.assertEqual(pairs(cap.last), [("limit", "10"), ("offset", "20")])

    def test_id_is_encoded_as_one_segment(self):
        cap = Capture(payload=HISTORY)
        with make_client(cap) as client:
            client.table("games").history("a/b c")
        self.assertEqual(cap.last.url.raw_path, b"/api/history/games/a%2Fb%20c")


class TestAsync(unittest.IsolatedAsyncioTestCase):
    async def test_list_query_and_history(self):
        cap = Capture(payload={"data": [], "pagination": None})
        async with AsyncKitsudenClient(
            BASE, api_key="kitsuden_sk_test", transport=httpx.MockTransport(cap)
        ) as client:
            await client.table("games").list(
                search="zelda",
                search_fields=["title"],
                filters={"price": {"gte": 10, "lt": 20}},
                filter_field="slug",
                filter_op="equals",
                filter_value="z",
            )
            self.assertEqual(
                pairs(cap.last),
                [
                    ("search", "zelda"),
                    ("search_fields", "title"),
                    ("filter[price][gte]", "10"),
                    ("filter[price][lt]", "20"),
                    ("filter_field", "slug"),
                    ("filter_op", "equals"),
                    ("filter_value", "z"),
                ],
            )

            cap.payload = HISTORY
            result = await client.table("games").history("uuid-1", limit=5, offset=0)
            self.assertEqual(cap.last.url.path, "/api/history/games/uuid-1")
            self.assertEqual(pairs(cap.last), [("limit", "5"), ("offset", "0")])
            self.assertEqual(result["total"], 0)

    async def test_unknown_operator_async(self):
        cap = Capture(payload={"data": []})
        async with AsyncKitsudenClient(BASE, transport=httpx.MockTransport(cap)) as client:
            with self.assertRaises(ValueError):
                await client.table("games").list(filters={"price": {"like": "x"}})
        self.assertIsNone(cap.last)


if __name__ == "__main__":
    unittest.main()
