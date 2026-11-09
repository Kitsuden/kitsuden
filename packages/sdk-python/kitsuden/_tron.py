"""
TRON decoder (Token Reduced Object Notation, https://tron-format.github.io/).

The twin of ``packages/sdk/src/api/tron.ts``: decode only (the API encodes, and
sends TRON only after checking that it decodes back to the same data). An
independent implementation, so the SDK keeps ``httpx`` as its only dependency.
Parity with the reference parser is tested on the fixtures shared with the
TypeScript SDK (``packages/sdk/tests/fixtures/tron-cases.json``, copied to
``tests/fixtures/tron-cases.json``).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

__all__ = ["decode_tron", "TronDecodeError"]


class TronDecodeError(ValueError):
    """Malformed TRON. Never returns partial data."""

    def __init__(self, message: str):
        super().__init__(f"TRON: {message}")


_SYMBOLS = {"(": "(", ")": ")", "[": "[", "]": "]", "{": "{", "}": "}", ",": ",", ":": ":", ";": ";", "=": "="}
_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
_NUM = re.compile(r"[0-9.eE+\-]")
_IDENT_START = re.compile(r"[A-Za-z_]")
_IDENT = re.compile(r"[A-Za-z0-9_]")
_INTEGER = re.compile(r"^-?\d+$")

# Token kinds
_CLASS, _IDENTK, _STR, _NUMK, _TRUE, _FALSE, _NULL, _NL, _EOF = (
    "class", "ident", "str", "num", "true", "false", "null", "nl", "eof",
)


def _tokens(src: str) -> List[Tuple[str, str, int]]:
    out: List[Tuple[str, str, int]] = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c in " \t\r":
            i += 1
        elif c == "\n":
            out.append((_NL, c, i))
            i += 1
        elif c == "#":
            while i < n and src[i] != "\n":
                i += 1
        elif c in _SYMBOLS:
            out.append((c, c, i))
            i += 1
        elif c == '"':
            at = i
            i += 1
            parts: List[str] = []
            while True:
                if i >= n:
                    raise TronDecodeError(f"unterminated string at {at}")
                d = src[i]
                if d == '"':
                    i += 1
                    break
                if d == "\\":
                    if i + 1 >= n:
                        raise TronDecodeError(f"unterminated string at {at}")
                    e = src[i + 1]
                    if e == "u":
                        hex_digits = src[i + 2 : i + 6]
                        if not re.fullmatch(r"[0-9a-fA-F]{4}", hex_digits):
                            raise TronDecodeError(f"bad \\u escape at {i}")
                        parts.append(chr(int(hex_digits, 16)))
                        i += 6
                    else:
                        parts.append(_ESCAPES.get(e, e))
                        i += 2
                else:
                    parts.append(d)
                    i += 1
            # 😀 → one code point, like JavaScript strings
            text = "".join(parts).encode("utf-16", "surrogatepass").decode("utf-16")
            out.append((_STR, text, at))
        elif c == "-" or c.isdigit():
            at = i
            i += 1
            while i < n and _NUM.match(src[i]):
                i += 1
            out.append((_NUMK, src[at:i], at))
        elif _IDENT_START.match(c):
            at = i
            i += 1
            while i < n and _IDENT.match(src[i]):
                i += 1
            v = src[at:i]
            kind = {"class": _CLASS, "true": _TRUE, "false": _FALSE, "null": _NULL}.get(v, _IDENTK)
            out.append((kind, v, at))
        else:
            raise TronDecodeError(f"unexpected character {c!r} at {i}")
    out.append((_EOF, "", n))
    return out


class _Parser:
    def __init__(self, src: str):
        self.tk = _tokens(src)
        self.p = 0
        self.kinds: Dict[str, List[str]] = {}

    def at(self, kind: str) -> bool:
        return self.tk[self.p][0] == kind

    def next_is(self, kind: str) -> bool:
        return self.p + 1 < len(self.tk) and self.tk[self.p + 1][0] == kind

    def take(self, kind: str) -> bool:
        if self.at(kind):
            self.p += 1
            return True
        return False

    def require(self, kind: str, expected: str) -> Tuple[str, str, int]:
        k = self.tk[self.p]
        if k[0] != kind:
            raise TronDecodeError(f"expected {expected} at {k[2]}, found {k[1]!r}")
        self.p += 1
        return k

    def separators(self) -> None:
        while self.take(";") or self.take(_NL):
            pass

    def skip_newlines(self) -> None:
        while self.take(_NL):
            pass

    def class_definition(self) -> None:
        name = self.require(_IDENTK, "class name")[1]
        props: List[str] = []
        if self.take("("):
            parent = self.require(_IDENTK, "parent class name")[1]
            if parent not in self.kinds:
                raise TronDecodeError(f"undefined parent class {parent}")
            props = list(self.kinds[parent])
            self.require(")", "')'")
        self.require(":", "':'")
        while not self.at(";") and not self.at(_CLASS) and not self.at(_EOF):
            if self.take(_NL):
                if self.at(_CLASS) or self.at(_EOF):
                    break
                if self.at(_IDENTK) and self.next_is("("):
                    break
                if not self.at(_IDENTK) and not self.at(_STR):
                    break
                continue
            if self.take(","):
                continue
            if self.at(_IDENTK) or self.at(_STR):
                props.append(self.tk[self.p][1])
                self.p += 1
            else:
                break
        self.kinds[name] = props

    def value(self) -> Any:
        kind, v, at = self.tk[self.p]
        if kind == _NULL:
            self.p += 1
            return None
        if kind == _TRUE:
            self.p += 1
            return True
        if kind == _FALSE:
            self.p += 1
            return False
        if kind == _NUMK:
            self.p += 1
            try:
                if _INTEGER.match(v):
                    return int(v)
                f = float(v)
            except ValueError:
                raise TronDecodeError(f"bad number {v!r} at {at}") from None
            return int(f) if f.is_integer() and "e" not in v.lower() and "." not in v else f
        if kind == _STR:
            self.p += 1
            return v
        if kind == "[":
            self.p += 1
            arr: List[Any] = []
            while True:
                self.skip_newlines()
                if self.at("]"):
                    break
                arr.append(self.value())
                self.skip_newlines()
                if not self.take(","):
                    break
            self.require("]", "']'")
            return arr
        if kind == "{":
            self.p += 1
            obj: Dict[str, Any] = {}
            while True:
                self.skip_newlines()
                if self.at("}"):
                    break
                key = self.require(_STR, "quoted key")[1]
                self.require(":", "':'")
                obj[key] = self.value()
                self.skip_newlines()
                if not self.take(","):
                    break
            self.require("}", "'}'")
            return obj
        if kind == _IDENTK:
            return self.instance()
        raise TronDecodeError(f"unexpected {v!r} at {at}")

    def instance(self) -> Dict[str, Any]:
        _, name, at = self.tk[self.p]
        self.p += 1
        if name not in self.kinds:
            raise TronDecodeError(f"undefined class {name} at {at}")
        props = self.kinds[name]
        self.require("(", "'('")
        obj: Dict[str, Any] = {}
        set_keys = set()
        position = 0
        named = False
        while True:
            self.skip_newlines()
            if self.at(")"):
                break
            if (self.at(_IDENTK) or self.at(_STR)) and self.next_is("="):
                named = True
                prop = self.tk[self.p][1]
                if prop not in props:
                    raise TronDecodeError(f"unknown property {prop} of {name}")
                if prop in set_keys:
                    raise TronDecodeError(f"property {prop} repeated")
                self.p += 2
                obj[prop] = self.value()
                set_keys.add(prop)
            else:
                if named:
                    raise TronDecodeError("positional argument after a named one")
                if position >= len(props):
                    raise TronDecodeError(f"too many arguments for {name}")
                prop = props[position]
                position += 1
                obj[prop] = self.value()
                set_keys.add(prop)
            self.skip_newlines()
            if not self.take(","):
                break
        if len(set_keys) < len(props):
            missing = ", ".join(p for p in props if p not in set_keys)
            raise TronDecodeError(f"missing arguments for {name}: {missing}")
        self.require(")", "')'")
        return obj

    def document(self) -> Any:
        self.separators()
        while self.take(_CLASS):
            self.class_definition()
            self.separators()
        if self.at(_EOF):
            raise TronDecodeError("no data section")
        data = self.value()
        self.separators()
        if not self.at(_EOF):
            k = self.tk[self.p]
            raise TronDecodeError(f"unexpected {k[1]!r} after the data at {k[2]}")
        return data


def decode_tron(text: str) -> Any:
    """Decode a TRON document into plain Python values (dict, list, str, int, float, bool, None)."""
    return _Parser(text).document()
