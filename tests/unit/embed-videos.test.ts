/**
 * Pasting a YouTube link has to work
 * ============================================================================
 *
 * ── THE FAILURE, MEASURED ──────────────────────────────────────────────────
 *
 * A normal YouTube link CANNOT be put in an `<iframe>`. Checked
 * with `curl` against YouTube:
 *
 *     GET https://www.youtube.com/watch?v=…   →  X-Frame-Options: SAMEORIGIN
 *     GET https://www.youtube.com/embed/…     →  (no X-Frame-Options)
 *
 * And the «Embed» block asked for exactly the form that does not work: its
 * placeholder said `https://youtube.com/watch?v=...`.
 *
 * Result: you pasted the link, the block was saved without a complaint, and the
 * page showed a BLANK FRAME. It is the worst possible failure mode — everything
 * looks right except the result.
 *
 * ── WHY IT IS NORMALIZED AT RENDER TIME ────────────────────────────────────
 *
 * And not in the editor: that way blocks ALREADY SAVED with the bad URL start
 * working without touching them one by one.
 */

import { renderBlocks, embedUrl } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

const ID = "dQw4w9WgXcQ";

describe("YouTube URLs that people really paste", () => {
  const cases: Array<[string, string]> = [
    // The one in the browser bar — the one that cannot be embedded.
    [`https://www.youtube.com/watch?v=${ID}`, `https://www.youtube.com/embed/${ID}`],
    // The one from the «Share» button.
    [`https://youtu.be/${ID}`, `https://www.youtube.com/embed/${ID}`],
    // Without `www`.
    [`https://youtube.com/watch?v=${ID}`, `https://www.youtube.com/embed/${ID}`],
    // Mobile.
    [`https://m.youtube.com/watch?v=${ID}`, `https://www.youtube.com/embed/${ID}`],
    // Shorts.
    [`https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}`],
    // Live streams.
    [`https://www.youtube.com/live/${ID}`, `https://www.youtube.com/embed/${ID}`],
    // The one that was already correct: left untouched.
    [`https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/embed/${ID}`],
  ];

  for (const [input, expected] of cases) {
    it(input, () => {
      expect(embedUrl(input)).toBe(expected);
    });
  }

  it("keeps the timestamp in its three forms", () => {
    /**
     * `t=90`, `t=1m30s` and `t=1h2m3s` all come from YouTube depending on where
     * you click «share». Someone who pastes a link with a minute mark expects it to start
     * there; losing it along the way means losing their intent without warning.
     */
    expect(embedUrl(`https://youtu.be/${ID}?t=90`)).toBe(
      `https://www.youtube.com/embed/${ID}?start=90`
    );
    expect(embedUrl(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)).toBe(
      `https://www.youtube.com/embed/${ID}?start=90`
    );
    expect(embedUrl(`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`)).toBe(
      `https://www.youtube.com/embed/${ID}?start=3723`
    );
  });

  it("respects the no-cookie domain if you set it", () => {
    /**
     * Whoever writes `youtube-nocookie` does so on purpose —privacy, cookie
     * notices—. Swapping it for the normal domain would silently undo
     * their decision.
     */
    expect(embedUrl(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}`
    );
  });
});

describe("other platforms", () => {
  it("Vimeo goes to its player", () => {
    expect(embedUrl("https://vimeo.com/123456789")).toBe(
      "https://player.vimeo.com/video/123456789"
    );
  });

  it("what is not recognized is left intact", () => {
    /**
     * Some services do accept their normal URL in an iframe. Guessing too much
     * would break the ones that work today.
     */
    expect(embedUrl("https://example.test/something")).toBe("https://example.test/something");
  });

  it("still does not let a `javascript:` through", () => {
    /**
     * Normalization relies on `safeUrl`, so it does not open a new hole
     * through the back door.
     */
    expect(embedUrl("javascript:alert(1)")).toBe("");
    expect(embedUrl("data:text/html,<script>alert(1)</script>")).toBe("");
  });
});

describe("the full block", () => {
  it("a pasted link from the bar produces an iframe that does load", () => {
    const { html } = renderBlocks([
      {
        id: "1",
        type: "embed",
        order: 0,
        data: {
          url: `https://www.youtube.com/watch?v=${ID}`,
          caption: "A video",
          aspectRatio: "16:9",
        },
      },
    ]);

    expect(html).toContain(`src="https://www.youtube.com/embed/${ID}"`);
    expect(
      html,
      "the /watch URL cannot reach the iframe: YouTube rejects it with " +
        "X-Frame-Options and a blank frame appears"
    ).not.toContain("watch?v=");
    expect(html).toContain("<figcaption>A video</figcaption>");
  });
});
