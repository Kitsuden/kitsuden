/**
 * Third-party admin views: Web Components in `.js`
 * ============================================================================
 *
 * The views a kon contributes to the admin are NOT `.svelte` source imported
 * at build time: they are Web Components (`type: "element"`) loaded at
 * RUNTIME, already built. The admin core is still Svelte; the extension point
 * is deliberately plain `.js` so that a third party does not have to compile
 * against our toolchain.
 *
 * That is why there is no —and must not be— `.d.ts` next to each component,
 * and why TypeScript complains (TS7016) when a test imports them.
 *
 * Importing such a component is ALWAYS for its side effect: when evaluated,
 * the module registers itself in `customElements`. It exports nothing that is
 * used. Hence the type declared here is empty: saying `any` would invite
 * reading exports that do not exist.
 *
 * To test another component, add its line. They are listed one by one on
 * purpose: a generic `declare module "*.js"` would also swallow the type errors
 * of any legitimate `.js` that entered the program.
 */

declare module "*/admin/tierlist-editor.js" {
  const _: Record<string, never>;
  export = _;
}
