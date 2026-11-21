/**
 * Kon events: who may emit and who may hear (2026-11-20).
 *
 *   - kon-dc's announcements could `ctx.events.on("koe:message.received")` and
 *     relay a visitor's message text: another kon's event now reaches a kon
 *     only when the emitting kon shares it (`events.public`,
 *     `events.subscribers`), or it is in the built-in lists;
 *   - H66: a kon could emit under another kon's name or the core's
 *     (`entry:created`, `payment:payment.succeeded`): it now emits only in its
 *     own namespaces, and anything else is dropped.
 *
 * The bus is a real EventEmitter; nothing else is loaded.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindKonEvents,
  konEventNamespaces,
  mayEmitKonEvent,
  mayListenToKonEvent,
  resetKonEventAccessForTests,
  setKonEventSharing,
} from "../../apps/api/src/lib/kon-event-access";
import { bindKonContext } from "../../apps/api/src/lib/kon-setup";
import {
  konEventsProblem,
  mergeKonEventDeclarations,
  type KonContext,
  type KonEvents,
} from "../../packages/shared/src";

function bus(): KonEvents & { raw: EventEmitter } {
  const raw = new EventEmitter();
  return {
    raw,
    emit: (event, data) => void raw.emit(event, data),
    on: (event, handler) => void raw.on(event, handler),
  };
}

beforeEach(() => resetKonEventAccessForTests());
afterEach(() => vi.restoreAllMocks());

describe("listening to another kon's events", () => {
  it("kon-dc no longer hears koe:message.received", () => {
    const base = bus();
    const report = vi.fn();
    const dc = bindKonEvents("kon-dc", base, report);
    const heard = vi.fn();
    dc.on("koe:message.received", heard);

    bindKonEvents("kon-koe", base).emit("koe:message.received", { text: "my address is…" });

    expect(heard).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatch(/kon-dc listens to "koe:message.received"/);
  });

  it("delivers when the emitter names the listener in events.subscribers", () => {
    setKonEventSharing("kon-koe", { subscribers: { "kon-dc": ["koe:message.*"] } });
    expect(mayListenToKonEvent("kon-dc", "koe:message.received")).toBe(true);
    expect(mayListenToKonEvent("kon-other", "koe:message.received")).toBe(false);
    expect(mayListenToKonEvent("kon-dc", "koe:contact.created")).toBe(false);
  });

  it("delivers to any kon what the emitter lists in events.public", () => {
    setKonEventSharing("kon-koe", { public: ["koe:conversation.closed"] });
    expect(mayListenToKonEvent("kon-dc", "koe:conversation.closed")).toBe(true);
    expect(mayListenToKonEvent("kon-dc", "koe:message.received")).toBe(false);
  });

  it("decides at delivery: a declaration that arrives after the subscription counts", () => {
    const base = bus();
    const heard = vi.fn();
    bindKonEvents("kon-dc", base, () => {}).on("koe:message.received", heard);
    setKonEventSharing("kon-koe", { subscribers: { "kon-dc": ["koe:message.received"] } });
    bindKonEvents("kon-koe", base).emit("koe:message.received", { id: 1 });
    expect(heard).toHaveBeenCalledWith({ id: 1 });
  });

  it("stops delivering when the emitter is forgotten (turned off)", () => {
    setKonEventSharing("kon-koe", { public: ["koe:message.received"] });
    expect(mayListenToKonEvent("kon-dc", "koe:message.received")).toBe(true);
    setKonEventSharing("kon-koe", undefined);
    expect(mayListenToKonEvent("kon-dc", "koe:message.received")).toBe(false);
  });

  it("ignores patterns an emitter writes for someone else's namespace", () => {
    const problems = setKonEventSharing("kon-evil", {
      public: ["koe:message.*"],
      subscribers: { "kon-dc": ["payment:payment.succeeded"] },
    });
    expect(problems).toHaveLength(2);
    expect(mayListenToKonEvent("kon-dc", "koe:message.received")).toBe(false);
    expect(mayListenToKonEvent("kon-dc", "payment:payment.succeeded")).toBe(false);
  });

  it("a kon always hears its own namespace and the core's", () => {
    expect(mayListenToKonEvent("kon-koe", "koe:message.received")).toBe(true);
    expect(mayListenToKonEvent("kon-dc", "entry:created")).toBe(true);
    expect(mayListenToKonEvent("kon-dc", "auth:user.created")).toBe(true);
    expect(mayListenToKonEvent("kon-dc", "entry.created")).toBe(true);
    expect(mayListenToKonEvent("kon-ecommerce", "shop:order.paid")).toBe(true);
  });

  it("keeps the subscriptions the published kons already made", () => {
    expect(mayListenToKonEvent("kon-crm", "shop:order.paid")).toBe(true);
    expect(mayListenToKonEvent("kon-members", "payment:subscription.renewed")).toBe(true);
    expect(mayListenToKonEvent("kon-newsletter", "blog:post:published")).toBe(true);
    expect(mayListenToKonEvent("kon-dc", "blog:post:published")).toBe(true);
    // …and nothing beyond them.
    expect(mayListenToKonEvent("kon-dc", "shop:order.paid")).toBe(false);
    expect(mayListenToKonEvent("kon-members", "shop:order.paid")).toBe(false);
  });
});

describe("emitting (H66)", () => {
  it("a kon emits in its own namespace", () => {
    const base = bus();
    const heard = vi.fn();
    base.raw.on("koe:message.received", heard);
    bindKonEvents("kon-koe", base).emit("koe:message.received", 1);
    expect(heard).toHaveBeenCalledWith(1);
  });

  it("drops an event under the core's or another kon's name, and says so once", () => {
    const base = bus();
    const heard = vi.fn();
    base.raw.on("entry:created", heard);
    base.raw.on("payment:payment.succeeded", heard);
    const report = vi.fn();
    const evil = bindKonEvents("kon-evil", base, report);
    evil.emit("entry:created", {});
    evil.emit("entry:created", {});
    evil.emit("payment:payment.succeeded", {});
    expect(heard).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]![0]).toMatch(/outside its namespaces/);
  });

  it("legacy names stay with their kon, and a look-alike does not get them", () => {
    expect(mayEmitKonEvent("kon-ecommerce", "shop:order.paid")).toBe(true);
    expect(mayEmitKonEvent("kon-payments", "payment:payment.succeeded")).toBe(true);
    expect(mayEmitKonEvent("kon-datasets", "entry:created")).toBe(true);
    // The page builder's page:updated / page:deleted (visual editors and the site cache hear them).
    expect(mayEmitKonEvent("kon-blocks", "page:updated")).toBe(true);
    expect(mayEmitKonEvent("kon-pages", "page:updated")).toBe(false);
    expect(mayEmitKonEvent("kon-shop", "shop:order.paid")).toBe(false);
    expect(mayEmitKonEvent("kon-payment", "payment:payment.succeeded")).toBe(false);
    expect(konEventNamespaces("kon-entry")).toEqual([]);
    expect(konEventNamespaces("kon-auth")).toEqual([]);
  });

  it("rejects names that are not event names", () => {
    expect(mayEmitKonEvent("kon-koe", "koe")).toBe(false);
    expect(mayEmitKonEvent("kon-koe", 42)).toBe(false);
    expect(mayEmitKonEvent("kon-koe", "KOE:x")).toBe(false);
  });
});

describe("the context a kon receives", () => {
  it("bindKonContext binds ctx.events to the kon", () => {
    const base = bus();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = bindKonContext({ events: base } as unknown as KonContext, "kon-dc");
    const heard = vi.fn();
    ctx.events.on("koe:message.received", heard);
    base.raw.emit("koe:message.received", { text: "x" });
    ctx.events.emit("koe:message.received", {});
    expect(heard).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("declarations", () => {
  it("validates public and subscribers", () => {
    expect(konEventsProblem({ public: ["koe:message.*"] })).toBeNull();
    expect(konEventsProblem({ public: ["*"] })).toMatch(/public event/);
    expect(konEventsProblem({ public: ["koe*"] })).toMatch(/public event/);
    expect(konEventsProblem({ subscribers: { "Kon DC": ["koe:x"] } })).toMatch(/kon id/);
    expect(konEventsProblem({ subscribers: { "kon-dc": "koe:x" as never } })).toMatch(/list/);
  });

  it("merges kon.json over the code's declaration", () => {
    const merged = mergeKonEventDeclarations(
      { public: ["koe:a.b"], subscribers: { "kon-dc": ["koe:c.d"] } },
      { public: ["koe:e.f"], subscribers: { "kon-dc": ["koe:g.h"], "kon-crm": ["koe:i.j"] } }
    );
    expect(merged?.public).toEqual(["koe:a.b", "koe:e.f"]);
    expect(merged?.subscribers).toEqual({
      "kon-dc": ["koe:c.d", "koe:g.h"],
      "kon-crm": ["koe:i.j"],
    });
    expect(mergeKonEventDeclarations(undefined, "nonsense")).toBeUndefined();
  });
});
