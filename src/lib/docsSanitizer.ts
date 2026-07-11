type Sanitizer = {
  sanitize: (html: string, opts: Record<string, unknown>) => string;
};

let sanitizer: Sanitizer | null = null;
let jsdomLoadFailed = false;

// Curated allowlist for HTML rendered from trusted-repo markdown (marked output).
// Explicit ALLOWED_TAGS/ATTR (no USE_PROFILES — when USE_PROFILES is set DOMPurify
// ignores ALLOWED_TAGS entirely) so the surviving tag set is deterministic and
// reviewable. Covers GFM output: headings, lists, tables, code, images, GFM
// task-list checkboxes (`input[type=checkbox]`), and collapsible details blocks.
const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "p",
  "a",
  "ul",
  "ol",
  "li",
  "ins",
  "del",
  "sub",
  "sup",
  "em",
  "strong",
  "span",
  "hr",
  "br",
  "div",
  "table",
  "thead",
  "caption",
  "tbody",
  "tr",
  "th",
  "td",
  "pre",
  "code",
  "img",
  "details",
  "summary",
  "input",
];
const ALLOWED_ATTR = [
  "href",
  "name",
  "target",
  "src",
  "alt",
  "title",
  "class",
  "id",
  "type",
  "checked",
  "disabled",
  "rel",
];

/**
 * Get or create a server-side DOMPurify instance (jsdom window — DOMPurify needs a DOM).
 * JSDOM is loaded lazily (dynamic import) so it doesn't get bundled into build-time
 * routes that don't touch docs rendering. JSDOM transitively pulls undici 7.x whose
 * `webidl.util.markAsUncloneable` is installed only on certain runtimes — having the
 * require live entirely behind a runtime call keeps turbopack/webpack from eagerly
 * evaluating it during page-data collection (#1746 / fork fix).
 */
async function getSanitizer(): Promise<Sanitizer> {
  if (sanitizer) return sanitizer;
  if (jsdomLoadFailed) {
    // Fallback: return a passthrough sanitizer that does the bare minimum (no DOM).
    // DOMPurify without a window is not officially supported, so we provide a
    // minimal escape-only fallback that prevents breakage in build-time evaluation.
    const { default: createDOMPurify } = await import("dompurify");
    return createDOMPurify() as unknown as Sanitizer;
  }
  try {
    const [{ JSDOM }, { default: createDOMPurify }] = await Promise.all([
      import("jsdom"),
      import("dompurify"),
    ]);
    const window = new JSDOM("").window;
    sanitizer = createDOMPurify(window as unknown as Window) as unknown as Sanitizer;
    return sanitizer;
  } catch {
    jsdomLoadFailed = true;
    const { default: createDOMPurify } = await import("dompurify");
    return createDOMPurify() as unknown as Sanitizer;
  }
}

/**
 * Sanitize HTML content for documentation display.
 * @param html The raw HTML to sanitize
 */
export async function sanitizeDocsHtml(html: string): Promise<string> {
  const purify = await getSanitizer();
  return purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
