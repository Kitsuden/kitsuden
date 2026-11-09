/**
 * Uploading to the library — the contract with the endpoint
 * ============================================================================
 *
 * This file exists because there were THREE separately written uploads and one
 * of them was broken in two ways at once, silently:
 *
 *   · `DynamicForm` sent the file as `file`; the endpoint reads `files`.
 *     It died before starting with "No files provided".
 *   · And it read `data.url`, which **never existed** in that response. Even if
 *     the upload had worked, the field would have been saved as `undefined`.
 *
 * Nobody noticed because an `alert()` saying "Failed to upload" and an empty
 * field look a lot like "that image was not valid".
 *
 * What is pinned here is the shape of the exchange, which is where the bug was.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { api } from "$lib/api";

import { imagesOf, uploadMedia } from "./upload";

vi.mock("$lib/api", () => ({ api: { uploadMedia: vi.fn() } }));

const apiUploadMedia = api.uploadMedia as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => apiUploadMedia.mockReset());

const file = (name = "a.png", type = "image/png") => new File(["x"], name, { type });

describe("upload", () => {
  it("returns the URL, which is what the uploader needs", () => {
    // The reason for all of this: without `url` in the response, the blog editor had
    // to reload the whole library to find by id what it had just
    // uploaded, and the datasets form did not even try.
    apiUploadMedia.mockResolvedValue({
      success: true,
      files: [{ id: "m1", filename: "a.png", url: "/uploads/a.png", success: true }],
    });

    return expect(uploadMedia([file()])).resolves.toEqual({
      uploaded: [
        { id: "m1", url: "/uploads/a.png", filename: "a.png", width: undefined, height: undefined },
      ],
      errors: [],
    });
  });

  it("carries over the dimensions when they are present", async () => {
    apiUploadMedia.mockResolvedValue({
      success: true,
      files: [
        { id: "m1", filename: "a.png", url: "/u/a.png", width: 1200, height: 630, success: true },
      ],
    });

    const { uploaded } = await uploadMedia([file()]);
    expect(uploaded[0]).toMatchObject({ width: 1200, height: 630 });
  });

  it("a partial failure is NOT an exception: it is a result with errors", async () => {
    // The endpoint responds 207 when some go in and others do not. Throwing here
    // would also discard the ones that were uploaded.
    apiUploadMedia.mockResolvedValue({
      success: false,
      files: [
        { id: "m1", filename: "ok.png", url: "/u/ok.png", success: true },
        { filename: "huge.png", success: false, error: "File too large (max 10MB)" },
      ],
    });

    const { uploaded, errors: errors } = await uploadMedia([file(), file("huge.png")]);
    expect(uploaded).toHaveLength(1);
    expect(errors[0]).toContain("huge.png");
    // The specific reason travels along: a bare "upload error" does not distinguish a
    // 20 MB file from a full disk.
    expect(errors[0]).toContain("10MB");
  });

  it("a `success: true` WITHOUT a url is counted as an error, it does not slip through empty", async () => {
    // This is exactly the bug DynamicForm had: it saved `undefined` in the
    // field and the form looked correct until someone opened the entry.
    apiUploadMedia.mockResolvedValue({
      success: true,
      files: [{ id: "m1", filename: "a.png", success: true }],
    });

    const { uploaded, errors: errors } = await uploadMedia([file()]);
    expect(uploaded).toEqual([]);
    expect(errors[0]).toMatch(/did not return the stored image/);
  });

  it("with no files it does not call the server", async () => {
    await uploadMedia([]);
    await uploadMedia(null);
    expect(apiUploadMedia).not.toHaveBeenCalled();
  });

  it("accepts a FileList just like an array", async () => {
    // `<input type=file>` gives a FileList; paste and drag give an array.
    apiUploadMedia.mockResolvedValue({ success: true, files: [] });
    const asFileList = { 0: file(), length: 1, item: () => file() } as unknown as FileList;

    await uploadMedia(asFileList);
    expect(apiUploadMedia).toHaveBeenCalledWith([expect.any(File)]);
  });
});

describe("filter what was pasted or dragged", () => {
  it("only images pass", () => {
    const data = {
      files: [file("doc.pdf", "application/pdf"), file("photo.jpg", "image/jpeg")],
    } as unknown as DataTransfer;

    expect(imagesOf(data).map((f) => f.name)).toEqual(["photo.jpg"]);
  });

  it("with no data it returns an empty list, it does not blow up", () => {
    expect(imagesOf(null)).toEqual([]);
  });
});
