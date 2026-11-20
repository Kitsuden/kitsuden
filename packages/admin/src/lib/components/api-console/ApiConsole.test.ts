/**
 * ApiConsole: the wiring around <rapi-doc-mini>, with a stand-in element.
 *
 *   - the document is fetched by the panel and handed over with loadSpec() as an object,
 *     neutralised and reduced to the chosen operation; the element is never given a URL;
 *   - the attributes that keep RapiDoc from loading URLs, mocking fetch or storing auth;
 *   - another choice in the list makes a new element with only that operation;
 *   - a kon without a document says so instead of a blank panel.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "$lib/api";
import { loadRapiDoc } from "$lib/api-console/rapidoc";

import ApiConsole from "./ApiConsole.svelte";

vi.mock("$lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("$lib/api-console/rapidoc", () => ({
  RAPIDOC_VERSION: "0.0.0-test",
  loadRapiDoc: vi.fn(),
}));

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const load = loadRapiDoc as unknown as ReturnType<typeof vi.fn>;

type Operation = { description?: string };
type Doc = { servers: unknown; paths: Record<string, Record<string, Operation>> };

const loaded: { el: HTMLElement; spec: Doc }[] = [];
class FakeMini extends HTMLElement {
  loadSpec(spec: Doc) {
    loaded.push({ el: this, spec });
    return Promise.resolve();
  }
}
if (!customElements.get("rapi-doc-mini")) customElements.define("rapi-doc-mini", FakeMini);

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Blog", version: "1" },
  servers: [{ url: "https://elsewhere.example/api" }],
  paths: {
    "/blog/posts": {
      get: {
        tags: ["posts"],
        summary: "List posts",
        description: "<img src=x onerror=alert(1)>",
        responses: {},
      },
      post: { tags: ["posts"], summary: "Create a post", responses: {} },
    },
  },
};

beforeEach(() => {
  loaded.length = 0;
  apiGet.mockReset();
  load.mockReset();
  load.mockResolvedValue(undefined);
});

describe("ApiConsole", () => {
  it("hands RapiDoc the neutralised document of the first operation, never a URL", async () => {
    apiGet.mockResolvedValue(SPEC);
    render(ApiConsole, { konId: "kon-blog" });

    await waitFor(() => expect(loaded).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledWith("/api/docs/blog/openapi.json");
    expect(load).toHaveBeenCalledTimes(1);

    const { el, spec } = loaded[0];
    expect(el.hasAttribute("spec-url")).toBe(false);
    expect(el.getAttribute("persist-auth")).toBe("false");
    expect(el.getAttribute("mock-server")).toBe("false");
    expect(el.getAttribute("allow-spec-url-load")).toBe("false");
    expect(el.getAttribute("allow-spec-file-load")).toBe("false");
    expect(el.getAttribute("fetch-credentials")).toBe("same-origin");

    expect(spec.servers).toEqual([{ url: `${location.origin}/api` }]);
    expect(Object.keys(spec.paths["/blog/posts"])).toEqual(["get"]);
    expect(spec.paths["/blog/posts"].get.description).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(screen.getByRole("status")).toBeInTheDocument(); // the session notice
  });

  it("another operation is a new element with only that operation", async () => {
    apiGet.mockResolvedValue(SPEC);
    render(ApiConsole, { konId: "blog" });
    await waitFor(() => expect(loaded).toHaveLength(1));

    const select = screen.getByRole("combobox");
    await fireEvent.change(select, { target: { value: "op:post /blog/posts" } });

    await waitFor(() => expect(loaded).toHaveLength(2));
    expect(loaded[0].el.isConnected).toBe(false);
    expect(loaded[1].el.isConnected).toBe(true);
    expect(Object.keys(loaded[1].spec.paths["/blog/posts"])).toEqual(["post"]);
  });

  it("a kon with no document says so", async () => {
    apiGet.mockRejectedValue(Object.assign(new Error("Kon not found"), { status: 404 }));
    render(ApiConsole, { konId: "nothing" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("ENABLE_SWAGGER");
    expect(loaded).toHaveLength(0);
  });
});
