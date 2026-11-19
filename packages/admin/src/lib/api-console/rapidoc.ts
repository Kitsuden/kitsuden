/**
 * RapiDoc's `<rapi-doc-mini>`, loaded only when an API console opens
 * ============================================================================
 *
 * The file is not a dependency of the panel: the API serves it itself, pinned
 * in `apps/api/src/lib/docs-viewers.json` (npm tarball checked against its
 * sha512, the file against its SRI) at `/api/docs/assets/rapidoc@<version>/…`.
 * The panel reads the version and the SRI from that same JSON at build time, so
 * a bump in one place moves both. Same origin (the panel's nginx proxies `/api`),
 * so the panel's `script-src 'self'` lets it in; the bundle is an ES module.
 */
import pins from "../../../../../apps/api/src/lib/docs-viewers.json";

const FILE = "rapidoc-min.js";
const pin = pins.viewers.rapidoc;

export const RAPIDOC_VERSION = pin.version;

/** The script's URL and SRI, under the API at `apiBase` ("" = this origin). */
export function rapidocScript(apiBase: string): { src: string; integrity: string } {
  return {
    src: `${apiBase}/api/docs/assets/rapidoc@${pin.version}/${FILE}`,
    integrity: pin.files[FILE].sri,
  };
}

let loading: Promise<void> | null = null;

/** Adds the script once; resolves when `<rapi-doc-mini>` is defined. A failure can be retried. */
export function loadRapiDoc(apiBase: string): Promise<void> {
  if (customElements.get("rapi-doc-mini")) return Promise.resolve();
  if (loading) return loading;
  const { src, integrity } = rapidocScript(apiBase);
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    const fail = () => {
      script.remove();
      loading = null;
      reject(new Error(src));
    };
    // A module that loads but throws while running never defines the element.
    script.onload = () => {
      const timer = setTimeout(fail, 10_000);
      void customElements.whenDefined("rapi-doc-mini").then(() => {
        clearTimeout(timer);
        resolve();
      });
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return loading;
}
