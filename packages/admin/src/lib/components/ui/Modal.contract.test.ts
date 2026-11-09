/**
 * The contract of `Modal`: without `open` NOTHING is shown
 * ============================================================================
 *
 * This file exists because of a specific, costly-to-find failure.
 *
 * `Modal` has its own gate (`{#if open}`), and `open` is `false` by
 * default. Five places in the admin used it like this:
 *
 *     {#if showMediaModal}
 *       <Modal title="…" onClose={…}>   <!-- no `open` -->
 *
 * It looks right and compiles: the component mounts when it should. But inside,
 * its own `open` is still `false`, so it paints nothing. The symptom is the
 * worst possible — **the button does nothing**: no error, no console, no
 * clue. The insert-image button in the blog editor had been like this
 * since it was written, along with «Manage Tags», «New category» and the two
 * create-from-dataset wizards.
 *
 * Both halves are tested:
 *   1. The component's BEHAVIOR, so that it is written down why the omission
 *      is invisible.
 *   2. That NO place in the admin omits it again. This last one is what
 *      really prevents the relapse, because the fault is not in `Modal` — it is in
 *      the caller.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";

import Modal from "./Modal.svelte";

describe("the Modal contract", () => {
  it("WITHOUT `open` nothing is rendered, not even the title", () => {
    render(Modal, { props: { title: "Insert image in the text" } });
    expect(screen.queryByText("Insert image in the text")).toBeNull();
  });

  it("with `open` it is visible", () => {
    render(Modal, { props: { open: true, title: "Insert image in the text" } });
    expect(screen.getByText("Insert image in the text")).toBeTruthy();
  });

  it("`open: false` does not render either: the default is no accident", () => {
    render(Modal, { props: { open: false, title: "Nada" } });
    expect(screen.queryByText("Nada")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(import.meta.dirname, "..", "..", "..");

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...svelteFiles(full));
    else if (entry.name.endsWith(".svelte")) out.push(full);
  }
  return out;
}

/** Every `<Modal …>` in the file, with its full opening tag. */
function modalTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<Modal(\s|>|\/)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    // Up to the `>` that closes the opening tag, skipping those that
    // are inside a `{...}` expression (e.g. `{a ? "x" : "y"}`).
    let depth = 0;
    let end = match.index;
    for (let i = match.index; i < source.length; i += 1) {
      const char = source[i];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

describe("nobody forgets `open`", () => {
  it("every admin `<Modal>` receives it", () => {
    const culprits: string[] = [];

    for (const file of svelteFiles(SRC)) {
      // Modal itself does not call itself; Dialog wraps it with
      // `bind:open`, which also counts.
      if (file.endsWith("Modal.svelte")) continue;

      const source = readFileSync(file, "utf8");
      for (const tag of modalTags(source)) {
        if (!/\bopen\b/.test(tag)) {
          culprits.push(`${file.replace(SRC, "src")}: ${tag.slice(0, 60)}…`);
        }
      }
    }

    expect(
      culprits,
      `These <Modal>s do not receive \`open\`, so they are NEVER SHOWN:\n${culprits.join("\n")}`
    ).toEqual([]);
  });
});
