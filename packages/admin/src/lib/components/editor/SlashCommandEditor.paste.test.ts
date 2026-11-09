/**
 * Pasting and dragging images into the editor
 * ============================================================================
 *
 * For a blog, pasting a screenshot is THE way to get images in: you take it and
 * paste it. It did not exist before — you had to open the picker, upload, and come back.
 *
 * What is pinned down here is the boundary that keeps this from getting in the way:
 *
 *   · Pasting TEXT has to keep working. It is 99% of pastes, and
 *     always cancelling it would have broken the whole editor to gain a convenience.
 *   · `dragover` must be cancelled or the browser OPENS the dropped file and
 *     takes the half-written article down with it, without warning.
 */

import { render } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";

import SlashCommandEditor from "./SlashCommandEditor.svelte";

/** A fake file; only its `type` is looked at. */
const file = (name: string, type: string) => new File(["x"], name, { type });

/**
 * jsdom does not build `ClipboardEvent`/`DragEvent` with data, so the
 * event is assembled by hand. It is what the browser delivers: a `DataTransfer` with
 * `files`.
 */
function eventWith(type: string, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const data = { files, items: [], types: files.length ? ["Files"] : ["text/plain"] };
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: data,
  });
  return event;
}

function mount(onUploadFiles?: (f: File[]) => void) {
  const { container } = render(SlashCommandEditor, { props: { value: "", onUploadFiles } });
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("there is no textarea");
  return textarea;
}

describe("pegar", () => {
  it("a screenshot is sent to upload", () => {
    const upload = vi.fn();
    const textarea = mount(upload);

    textarea.dispatchEvent(eventWith("paste", [file("captura.png", "image/png")]));

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0][0].name).toBe("captura.png");
  });

  it("PASTING TEXT is left alone", () => {
    // If it were always cancelled, pasting text would stop working — and that is
    // what is done almost all the time.
    const upload = vi.fn();
    const textarea = mount(upload);

    const event = eventWith("paste", []);
    textarea.dispatchEvent(event);

    expect(upload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("with an image it IS cancelled, so the binary is not pasted as text", () => {
    const textarea = mount(vi.fn());
    const event = eventWith("paste", [file("a.png", "image/png")]);

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("from a mixed clipboard only the images come out", () => {
    // Copying an image from a website ALSO brings its HTML; and someone may
    // drag a PDF along with a photo.
    const upload = vi.fn();
    const textarea = mount(upload);

    textarea.dispatchEvent(
      eventWith("paste", [file("doc.pdf", "application/pdf"), file("foto.jpg", "image/jpeg")])
    );

    expect(upload.mock.calls[0][0]).toHaveLength(1);
    expect(upload.mock.calls[0][0][0].name).toBe("foto.jpg");
  });
});

describe("drag and drop", () => {
  it("dropping an image sends it to upload", () => {
    const upload = vi.fn();
    const textarea = mount(upload);

    textarea.dispatchEvent(eventWith("drop", [file("b.webp", "image/webp")]));

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("`dragover` is CANCELLED or the browser opens the file", () => {
    // It is the classic drag-and-drop failure: you drop and the browser
    // navigates to the file, losing the article. There is no error or warning.
    const textarea = mount(vi.fn());
    const event = new Event("dragover", { bubbles: true, cancelable: true });

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("dropping something that is not an image does nothing", () => {
    const upload = vi.fn();
    const textarea = mount(upload);

    textarea.dispatchEvent(eventWith("drop", [file("hoja.xlsx", "application/vnd.ms-excel")]));

    expect(upload).not.toHaveBeenCalled();
  });
});

describe("with nobody to upload, it does not get in the way", () => {
  it("without `onUploadFiles` the paste is left to the browser", () => {
    // The editor does not know how to upload on its own. If nobody is listening, cancelling the
    // event would only make pasting stop working.
    const textarea = mount(undefined);
    const event = eventWith("dragover", []);

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
