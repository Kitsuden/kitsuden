/**
 * The blocks an editor can ADD from Inti's composer
 * ============================================================================
 *
 * Plain data, no Inti import: it is also documentation of what each block
 * stores. Only types of the Kitsuden page-builder palette
 * (`GET /api/page-builder/block-types`) are listed: `@intijs/adapter-kitsuden`
 * refuses to insert any other type, because the API would reject it.
 * `grid` and `custom` are left out (they need structure an inline editor
 * cannot give them); edit those in the admin.
 *
 * Shape: Inti's `ComposerBlockType` (`nativeType`, `label`, `defaults`,
 * `variants`).
 */
export const PALETTE = [
  {
    nativeType: "hero",
    label: "Hero",
    defaults: {
      headline: "New headline",
      description: "A short description.",
      alignment: "center",
      minHeight: "md",
    },
    variants: { alignment: ["left", "center", "right"], minHeight: ["sm", "md", "lg", "xl"] },
  },
  {
    nativeType: "text",
    label: "Text",
    defaults: { text: "Write something here.", format: "plain", alignment: "left" },
    variants: {
      alignment: ["left", "center", "right", "justify"],
      textSize: ["sm", "md", "lg", "xl"],
    },
  },
  {
    nativeType: "image",
    label: "Image",
    defaults: { mediaId: "", altText: "", caption: "" },
    variants: { alignment: ["left", "center", "right", "full"] },
  },
  { nativeType: "video", label: "Video", defaults: { embedUrl: "", provider: "youtube" } },
  {
    nativeType: "cards",
    label: "Cards",
    defaults: {
      columns: 3,
      cards: [{ id: "card-1", title: "Card title", description: "Card text." }],
    },
    variants: { variant: ["default", "horizontal", "compact"] },
  },
  {
    nativeType: "quote",
    label: "Quote",
    defaults: { quote: "A memorable sentence.", author: "Someone" },
    variants: { style: ["default", "large", "minimal"] },
  },
  {
    nativeType: "cta",
    label: "Call to action",
    defaults: { title: "Ready to start?", buttonLabel: "Contact us", buttonUrl: "/" },
    variants: {
      buttonVariant: ["primary", "secondary", "outline"],
      alignment: ["left", "center", "right"],
    },
  },
  { nativeType: "embed", label: "Embed", defaults: { code: "", caption: "" } },
  {
    nativeType: "divider",
    label: "Divider",
    defaults: { style: "solid" },
    variants: { style: ["solid", "dashed", "dotted"], width: ["full", "partial"] },
  },
  {
    nativeType: "spacer",
    label: "Spacer",
    defaults: { height: "md" },
    variants: { height: ["sm", "md", "lg", "xl", "2xl"] },
  },
] as const;
