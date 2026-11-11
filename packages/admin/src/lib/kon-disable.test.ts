import { beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { dependentsOf, disableKonPrompt, isCoreKon } from "./kon-disable";

const datasets = {
  key: "kon-datasets",
  name: "Datasets",
  category: "core",
  enabled: true,
  tables: ["datasets", "dataset_entries"],
};
const blog = {
  key: "kon-blog",
  name: "Blog",
  category: "optional",
  enabled: true,
  dependsOn: ["kon-datasets"],
};
const off = { key: "kon-crm", name: "CRM", enabled: false, dependsOn: ["kon-datasets"] };
const chat = { key: "kon-chat", name: "Chat", category: "optional", enabled: true };

describe("disableKonPrompt", () => {
  beforeEach(() => setLocale("en", { reload: false }));

  it("names the kon, what goes away and the tables that stay", () => {
    const p = disableKonPrompt(chat, [datasets, blog, chat]);
    expect(p.title).toContain("Chat");
    expect(p.description).toMatch(/menu/i);
    expect(p.description).toMatch(/data/i);
    expect(p.variant).toBe("danger");
  });

  it("is stronger for a core kon and lists what depends on it", () => {
    const p = disableKonPrompt(datasets, [datasets, blog, off, chat]);
    const plain = disableKonPrompt(chat, []);
    expect(isCoreKon(datasets)).toBe(true);
    expect(p.title).not.toBe(plain.title.replace("Chat", "Datasets"));
    expect(p.description).toMatch(/core/i);
    expect(p.description).toContain("Blog");
    expect(p.description).not.toContain("CRM");
    expect(p.description).toContain("datasets, dataset_entries");
    expect(p.confirmLabel).not.toBe(plain.confirmLabel);
  });

  it("only enabled kons count as dependents", () => {
    expect(dependentsOf(datasets, [datasets, blog, off]).map((d) => d.key)).toEqual(["kon-blog"]);
  });

  it("speaks Spanish too", () => {
    setLocale("es", { reload: false });
    expect(disableKonPrompt(chat, []).title).toMatch(/Chat/);
    expect(disableKonPrompt(chat, []).title).not.toBe(
      (() => {
        setLocale("en", { reload: false });
        return disableKonPrompt(chat, []).title;
      })()
    );
  });
});
