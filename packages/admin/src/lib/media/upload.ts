/**
 * Uploading files to the library
 * ============================================================================
 *
 * A single function for the whole admin. It existed written three times —in the
 * blog editor, in the Media view and in the datasets form— and all three
 * did different things:
 *
 *   · The blog editor uploaded fine, but then RELOADED the whole library
 *     to find by `id` what it had just uploaded, because the response did not
 *     carry the URL.
 *   · The datasets form sent the field with the wrong name
 *     (`file` where the API reads `files`) and read `data.url`, which never existed.
 *     It was broken in both ways at once.
 *
 * Now the endpoint returns the URL and the result is normalized here, so
 * the uploader directly receives what it needs to render or insert it.
 */

import { api } from "$lib/api";

export interface UploadedMedia {
  id: string;
  url: string;
  filename: string;
  width?: number;
  height?: number;
}

export interface UploadedResult {
  uploaded: UploadedMedia[];
  /**
   * Failures, already with file name and reason.
   *
   * A bare "Upload error" does not say whether the problem is the size, the format or
   * the disk, which are three different actions for whoever reads it.
   */
  errors: string[];
}

/**
 * Uploads and returns what was stored.
 *
 * **It never throws because of a bad file.** The endpoint responds 207 when some
 * go in and others do not, so here a partial failure is a normal result with
 * its list of errors — and the caller decides whether that is serious. Only a
 * network or session failure comes out as an exception.
 */
export async function uploadMedia(
  files: FileList | File[] | null | undefined
): Promise<UploadedResult> {
  const list = files ? Array.from(files) : [];
  if (list.length === 0) return { uploaded: [], errors: [] };

  const response = await api.uploadMedia(list);

  const uploaded: UploadedMedia[] = [];
  const errors: string[] = [];

  for (const file of response.files) {
    if (!file.success) {
      errors.push(`${file.filename}: ${file.error ?? "failed"}`);
      continue;
    }
    // Without `id` or without `url` there is nothing to insert or to save in a field.
    // It is counted as an error instead of slipping through as a silent gap.
    if (!file.id || !file.url) {
      errors.push(`${file.filename}: the server did not return the stored image`);
      continue;
    }
    uploaded.push({
      id: file.id,
      url: file.url,
      filename: file.filename,
      width: file.width,
      height: file.height,
    });
  }

  return { uploaded, errors };
}

/** Only the images from a clipboard or a drag. */
export function imagesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((f) => f.type.startsWith("image/"));
}
