"""
TOON decoder (https://toonformat.dev), a port of the API's own.

It is the decoder in ``apps/api/src/lib/toon-tabular.ts`` translated line by
line. It reads everything the API writes (and the reference implementation
``@toon-format/toon@4.4.0``): tables with columns folded into the header
(``docs[2]{id,_meta{ds,at}}:``), keyed tables (``byId[2:]{x,y}:``), list form
at any depth, inline arrays, the empty object (a bare ``key:`` with nothing
after it) and the ``,`` ``\\t`` ``|`` delimiters.

``tests/fixtures/toon-cases.json`` holds TOON to JSON pairs written by the
API's encoder. This package's test decodes all of them, and a test in the API
checks that they are still what its encoder writes today.

On malformed TOON it raises ``ToonDecodeError``: it never returns partial data.
"""

from __future__ import annotations

import re
from typing import Any, List, Optional, Tuple

INDENT_SIZE = 2
DELIMITER = ","
DELIMITERS = (",", "\t", "|")
NUMERIC_LITERAL = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$", re.IGNORECASE)
ARRAY_LENGTH = re.compile(r"^(?:0|[1-9]\d*)$")


class ToonDecodeError(ValueError):
    """Malformed TOON. ``line`` is the 1-based line number, when known."""

    def __init__(self, message: str, line: Optional[int] = None):
        super().__init__(f"Line {line}: {message}" if line is not None else message)
        self.line = line


class _Line:
    __slots__ = ("level", "text", "num")

    def __init__(self, level: int, text: str, num: int):
        self.level = level
        self.text = text
        self.num = num


def _scan(text: str) -> List[_Line]:
    out: List[_Line] = []
    for n, raw in enumerate(text.split("\n")):
        if n == 0 and raw.startswith("\uFEFF"):
            raw = raw[1:]
        if raw.endswith("\r"):
            raw = raw[:-1]
        indent = re.match(r"^[ \t]*", raw).group(0)
        has_tab = "\t" in indent
        content = raw[len(indent):].rstrip(" ")
        if not content:
            continue
        if not has_tab and content[0] == "#":
            continue
        if has_tab:
            raise ToonDecodeError("Tabs are not allowed in indentation", n + 1)
        out.append(_Line(len(indent) // INDENT_SIZE, content, n + 1))
    return out


def _trim(s: str) -> str:
    return s.strip(" ")


def _unescape(s: str) -> str:
    if "\\" not in s:
        return s
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        escape_char = s[i + 1] if i + 1 < len(s) else ""
        i += 2
        if escape_char == "n":
            out.append("\n")
        elif escape_char == "t":
            out.append("\t")
        elif escape_char == "r":
            out.append("\r")
        elif escape_char == "\\":
            out.append("\\")
        elif escape_char == '"':
            out.append('"')
        elif escape_char == "u":
            hex_digits = s[i : i + 4]
            if not re.fullmatch(r"[0-9a-fA-F]{4}", hex_digits):
                raise ValueError(f"Invalid escape sequence: \\u{hex_digits}")
            out.append(chr(int(hex_digits, 16)))
            i += 4
        else:
            raise ValueError(f"Invalid escape sequence: \\{escape_char}")
    return "".join(out)


def _closing_quote(s: str, start: int) -> int:
    i = start + 1
    while i < len(s):
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == '"':
            return i
        i += 1
    return -1


def _outside_quotes(s: str, ch: str, start: int = 0) -> int:
    inside = False
    i = start
    while i < len(s):
        c = s[i]
        if inside and c == "\\":
            i += 2
            continue
        if c == '"':
            inside = not inside
        elif not inside and c == ch:
            return i
        i += 1
    return -1


def _literal_text(token: str) -> str:
    t = _trim(token)
    if not t.startswith('"'):
        return t
    end = _closing_quote(t, 0)
    if end == -1:
        raise ValueError("Unterminated string: missing closing quote")
    if end != len(t) - 1:
        raise ValueError("Unexpected characters after closing quote")
    return _unescape(t[1:end])


def _primitive(token: str) -> Any:
    t = _trim(token)
    if not t:
        return ""
    if t.startswith('"'):
        return _literal_text(t)
    if t == "true":
        return True
    if t == "false":
        return False
    if t == "null":
        return None
    if NUMERIC_LITERAL.match(t):
        n = float(t)
        if n == n and n not in (float("inf"), float("-inf")):
            # Same as JSON: an integer with no decimals or exponent is an int
            if re.fullmatch(r"-?\d+", t):
                return int(t)
            return 0.0 if n == 0 else n
    return t


def _split(entry: str, delim: str) -> List[str]:
    values: List[str] = []
    current: List[str] = []
    inside = False
    i = 0
    while i < len(entry):
        c = entry[i]
        if inside and c == "\\" and i + 1 < len(entry):
            current.append(c + entry[i + 1])
            i += 2
            continue
        if c == '"':
            inside = not inside
            current.append(c)
        elif not inside and c == delim:
            values.append(_trim("".join(current)))
            current = []
        else:
            current.append(c)
        i += 1
    if current or values:
        values.append(_trim("".join(current)))
    return values


def _closing_brace(s: str, start: int) -> int:
    inside = False
    depth = 0
    i = start
    while i < len(s):
        c = s[i]
        if inside and c == "\\":
            i += 2
            continue
        if c == '"':
            inside = not inside
        elif not inside and c == "{":
            depth += 1
        elif not inside and c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


class _Field:
    __slots__ = ("name", "children")

    def __init__(self, name: str, children: Optional[List["_Field"]] = None):
        self.name = name
        self.children = children


def _read_fields(segment: str, delim: str) -> List[_Field]:
    parts: List[str] = []
    current: List[str] = []
    inside = False
    depth = 0
    i = 0
    while i < len(segment):
        c = segment[i]
        if inside and c == "\\" and i + 1 < len(segment):
            current.append(c + segment[i + 1])
            i += 2
            continue
        if c == '"':
            inside = not inside
        elif not inside and c == "{":
            depth += 1
        elif not inside and c == "}":
            depth -= 1
        elif not inside and depth == 0 and c == delim:
            parts.append("".join(current))
            current = []
            i += 1
            continue
        current.append(c)
        i += 1
    parts.append("".join(current))
    fields: List[_Field] = []
    for p in parts:
        t = _trim(p)
        if not t:
            raise ValueError("Empty field name in field list")
        opens = _outside_quotes(t, "{")
        if opens == -1:
            fields.append(_Field(_literal_text(t)))
            continue
        closes = _closing_brace(t, opens)
        if closes != len(t) - 1:
            raise ValueError("Unexpected content after nested field group")
        fields.append(_Field(_literal_text(t[:opens]), _read_fields(t[opens + 1 : closes], delim)))
    return fields


def _count_leaves(fields: List[_Field]) -> int:
    return sum(_count_leaves(c.children) if c.children else 1 for c in fields)


class _Header:
    __slots__ = ("key", "length", "delim", "fields", "with_key", "inline")

    def __init__(self, key, length, delim, fields, with_key, inline):
        self.key = key
        self.length = length
        self.delim = delim
        self.fields = fields
        self.with_key = with_key
        self.inline = inline


def _read_header(text: str) -> Optional[_Header]:
    if text.startswith('"'):
        end = _closing_quote(text, 0)
        if end == -1 or text[end + 1 : end + 2] != "[":
            return None
        opens = end + 1
    else:
        opens = _outside_quotes(text, "[")
    if opens == -1:
        return None
    first_colon = _outside_quotes(text, ":")
    if first_colon == -1 or first_colon < opens:
        return None
    closes = _outside_quotes(text, "]", opens)
    if closes == -1:
        raise ValueError("Unterminated bracket segment")

    braces_end = closes + 1
    brace_start = _outside_quotes(text, "{", closes)
    if brace_start != -1 and brace_start < _outside_quotes(text, ":", closes):
        if brace_start != closes + 1:
            raise ValueError("Unexpected content between bracket segment and field list")
        end = _closing_brace(text, brace_start)
        if end != -1:
            braces_end = end + 1
    colon = _outside_quotes(text, ":", max(closes, braces_end))
    if colon == -1:
        raise ValueError("Missing colon after array header")
    if colon != max(closes + 1, braces_end):
        raise ValueError("Unexpected content between bracket segment and colon")

    key = None
    if opens > 0:
        raw = text[:opens]
        if raw.endswith((" ", "\t")):
            raise ValueError("Unexpected whitespace between key and bracket segment")
        key = _literal_text(raw) if raw.startswith('"') else raw

    seg = text[opens + 1 : closes]
    delim = DELIMITER
    if seg.endswith("\t"):
        delim, seg = "\t", seg[:-1]
    elif seg.endswith("|"):
        delim, seg = "|", seg[:-1]
    with_key = False
    if seg.endswith(":"):
        with_key, seg = True, seg[:-1]
    if not ARRAY_LENGTH.match(seg):
        raise ValueError(f'Invalid array length: "{seg}"')

    fields = None
    if brace_start != -1 and brace_start < colon:
        end = _closing_brace(text, brace_start)
        if end != -1 and end < colon:
            content = text[brace_start + 1 : end]
            for other in DELIMITERS:
                if other != delim and _outside_quotes(content, other) != -1:
                    raise ValueError("Header delimiter mismatch")
            fields = _read_fields(content, delim)
    after = _trim(text[colon + 1 :])
    if with_key and not fields:
        raise ValueError("Keyed header requires a field list")
    if fields and after:
        raise ValueError("Unexpected content after fields-bearing header colon")
    return _Header(key, int(seg), delim, fields, with_key, after or None)


def _read_key(text: str) -> Tuple[str, int]:
    if text.startswith('"'):
        closes = _closing_quote(text, 0)
        if closes == -1:
            raise ValueError("Unterminated quoted key")
        p = closes + 1
        while p < len(text) and text[p] == " ":
            p += 1
        if p >= len(text) or text[p] != ":":
            raise ValueError("Missing colon after key")
        return _unescape(text[1:closes]), p + 1
    colon = _outside_quotes(text, ":")
    if colon == -1:
        raise ValueError("Missing colon after key")
    return _trim(text[:colon]), colon + 1


def _is_header_without_key(t: str) -> bool:
    return _trim(t).startswith("[") and _outside_quotes(t, ":") != -1


def _is_pair(t: str) -> bool:
    return _outside_quotes(t, ":") != -1


def _is_row(text: str, delim: str) -> bool:
    colon = _outside_quotes(text, ":")
    if colon == -1:
        return True
    d = _outside_quotes(text, delim)
    return d != -1 and d < colon


def _fields_object(fields: List[_Field], values: List[Any]) -> dict:
    it = iter(values)

    def build(nodes: List[_Field]) -> dict:
        o: dict = {}
        for n in nodes:
            o[n.name] = build(n.children) if n.children else next(it)
        return o

    return build(fields)


class _Decoder:
    def __init__(self, lines: List[_Line]):
        self.lines = lines
        self.i = 0

    def peek(self) -> Optional[_Line]:
        return self.lines[self.i] if self.i < len(self.lines) else None

    def read(self) -> Optional[_Line]:
        l = self.peek()
        self.i += 1
        return l

    @staticmethod
    def with_line(l: _Line, fn):
        try:
            return fn()
        except ToonDecodeError:
            raise
        except (ValueError, StopIteration) as e:
            raise ToonDecodeError(str(e), l.num) from e

    def document(self) -> Any:
        first = self.peek()
        if first is None:
            return {}
        if first.level != 0:
            raise ToonDecodeError("Over-indented line", first.num)
        if first.text == "[]":
            self.read()
            self.consumed()
            return []
        if _is_header_without_key(first.text):
            h = self.with_line(first, lambda: _read_header(first.text))
            if h:
                self.read()
                v = self.from_header(h, 0, first)
                self.consumed()
                return v
        self.read()
        if self.peek() is None and not _is_pair(first.text):
            return self.with_line(first, lambda: _primitive(first.text))
        if not _is_pair(first.text):
            raise ToonDecodeError("Top-level document must start with a key-value or array-header line", first.num)
        o: dict = {}
        self.read_pair(first, 0, o)
        while (l := self.peek()) is not None:
            if l.level != 0:
                raise ToonDecodeError("Over-indented line", l.num)
            self.read()
            self.read_pair(l, 0, o)
        return o

    def consumed(self) -> None:
        l = self.peek()
        if l is not None:
            raise ToonDecodeError("Unexpected content after the document root", l.num)

    def read_pair(self, l: _Line, base: int, o: dict) -> None:
        h = self.with_line(l, lambda: _read_header(l.text))
        if h:
            if h.key is None:
                raise ToonDecodeError("Keyless array header is only valid at the root or as a list item", l.num)
            if h.key in o:
                raise ToonDecodeError(f'Duplicate sibling key "{h.key}"', l.num)
            o[h.key] = self.from_header(h, base, l)
            return
        key, value_start = self.with_line(l, lambda: _read_key(l.text))
        if key in o:
            raise ToonDecodeError(f'Duplicate sibling key "{key}"', l.num)
        rest = _trim(l.text[value_start:])
        if not rest:
            next_line = self.peek()
            o[key] = self.fields(base + 1) if next_line is not None and next_line.level > base else {}
            return
        o[key] = [] if rest == "[]" else self.with_line(l, lambda: _primitive(rest))

    def fields(self, base: int) -> dict:
        o: dict = {}
        level = None
        while (l := self.peek()) is not None and l.level >= base:
            if level is None:
                level = l.level
            if l.level != level:
                raise ToonDecodeError(f"Over-indented line: expected depth {level}", l.num)
            self.read()
            self.read_pair(l, level, o)
        return o

    def content_level(self, base: int) -> int:
        l = self.peek()
        return base + 1 if l is None or l.level <= base + 1 else l.level

    def from_header(self, h: _Header, base: int, l: _Line) -> Any:
        if h.with_key:
            return self.table_with_key(h, base, l)
        if h.inline is not None:
            values = self.with_line(l, lambda: [_primitive(v) for v in _split(h.inline, h.delim)])
            if len(values) != h.length:
                raise ToonDecodeError(f"Expected {h.length} inline values, got {len(values)}", l.num)
            return values
        if h.fields:
            return self.table(h, base, l)
        return self.items(h, base, l)

    def table(self, h: _Header, base: int, header_line: _Line) -> list:
        level = self.content_level(base)
        leaves = _count_leaves(h.fields)
        rows: list = []
        while len(rows) < h.length:
            l = self.peek()
            if l is None or l.level <= base:
                break
            if l.level != level:
                raise ToonDecodeError(f"Over-indented line: expected depth {level}", l.num)
            if not _is_row(l.text, h.delim):
                break
            self.read()
            values = self.with_line(l, lambda: [_primitive(v) for v in _split(l.text, h.delim)])
            if len(values) != leaves:
                raise ToonDecodeError(f"Expected {leaves} row values, got {len(values)}", l.num)
            rows.append(_fields_object(h.fields, values))
        if len(rows) != h.length:
            raise ToonDecodeError(f"Expected {h.length} tabular rows, got {len(rows)}", header_line.num)
        return rows

    def table_with_key(self, h: _Header, base: int, header_line: _Line) -> dict:
        level = self.content_level(base)
        leaves = _count_leaves(h.fields)
        o: dict = {}
        while (l := self.peek()) is not None and l.level > base:
            if l.level != level:
                raise ToonDecodeError(f"Over-indented line: expected depth {level}", l.num)
            self.read()
            key, value_start = self.with_line(l, lambda: _read_key(l.text))
            if key in o:
                raise ToonDecodeError(f'Duplicate key "{key}"', l.num)
            cells = _trim(l.text[value_start:])
            values = [] if cells == "" else self.with_line(l, lambda: [_primitive(v) for v in _split(cells, h.delim)])
            if len(values) != leaves:
                raise ToonDecodeError(f"Expected {leaves} entry cells, got {len(values)}", l.num)
            o[key] = _fields_object(h.fields, values)
        if len(o) != h.length:
            raise ToonDecodeError(f"Expected {h.length} keyed entries, got {len(o)}", header_line.num)
        return o

    def items(self, h: _Header, base: int, header_line: _Line) -> list:
        level = self.content_level(base)
        items: list = []
        while len(items) < h.length:
            l = self.peek()
            if l is None or l.level <= base:
                break
            if l.level != level:
                raise ToonDecodeError(f"Over-indented line: expected depth {level}", l.num)
            if not (l.text.startswith("- ") or l.text == "-"):
                break
            items.append(self.item(level))
        if len(items) != h.length:
            raise ToonDecodeError(f"Expected {h.length} list items, got {len(items)}", header_line.num)
        next_line = self.peek()
        if next_line is not None and next_line.level == level and (next_line.text.startswith("- ") or next_line.text == "-"):
            raise ToonDecodeError(f"Expected {h.length} list items, but found more", next_line.num)
        return items

    def item(self, base: int) -> Any:
        l = self.read()
        if l.text == "-":
            return {}
        rest_after = l.text[2:].lstrip(" ")
        if not _trim(rest_after):
            return {}
        if _trim(rest_after) == "[]":
            return []
        li = _Line(l.level, rest_after, l.num)
        if _is_header_without_key(rest_after):
            h = self.with_line(li, lambda: _read_header(rest_after))
            if h:
                if h.with_key or h.fields:
                    raise ToonDecodeError("Keyless header with a field list is only valid at the root", li.num)
                return self.from_header(h, base, li)
        h = self.with_line(li, lambda: _read_header(rest_after))
        if h and h.key is not None and h.fields is not None:
            o: dict = {h.key: self.from_header(h, base + 1, li)}
            self.siblings(base + 1, o)
            return o
        if _is_pair(rest_after):
            o = {}
            self.read_pair(li, base + 1, o)
            self.siblings(base + 1, o)
            return o
        return self.with_line(li, lambda: _primitive(rest_after))

    def siblings(self, level: int, o: dict) -> None:
        while (l := self.peek()) is not None and l.level >= level:
            if l.level != level:
                raise ToonDecodeError(f"Over-indented line: expected depth {level}", l.num)
            self.read()
            self.read_pair(l, level, o)


def decode_toon(text: str) -> Any:
    """Decode TOON into Python dict/list/scalars. An empty document is ``{}``."""
    return _Decoder(_scan(text)).document()
