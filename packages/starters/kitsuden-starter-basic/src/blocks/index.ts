/**
 * Block type → component
 * ============================================================================
 *
 * The core page-builder types (the 12 of `GET /api/page-builder/block-types`)
 * plus the generic ones the admin editor offers (`richtext`, `image-gallery`,
 * `callout`). `grid` is rendered by `components/Block.astro` itself, because
 * it contains other blocks.
 *
 * Kitsuden also stores types that belong to optional kons (`tier-list`,
 * `game-map`, `deck`…). This site does not render them: in development they
 * show a labelled placeholder, in production nothing. To support one, add a
 * component here with the type as key.
 */
import callout from "./callout.astro";
import cards from "./cards.astro";
import cta from "./cta.astro";
import divider from "./divider.astro";
import embed from "./embed.astro";
import hero from "./hero.astro";
import imageGallery from "./image-gallery.astro";
import image from "./image.astro";
import quote from "./quote.astro";
import richtext from "./richtext.astro";
import spacer from "./spacer.astro";
import text from "./text.astro";
import video from "./video.astro";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BLOCKS: Record<string, (props: any) => unknown> = {
  hero,
  text,
  richtext,
  image,
  "image-gallery": imageGallery,
  video,
  cards,
  quote,
  cta,
  embed,
  callout,
  divider,
  spacer,
};

/** Types `components/Block.astro` knows how to render (BLOCKS + grid) */
export const RENDERED_TYPES = [...Object.keys(BLOCKS), "grid"];
