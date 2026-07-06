/**
 * Scripts injected into the page through CDP `Runtime.evaluate`.
 *
 * They are plain source strings rather than imported functions because they
 * execute inside the inspected page, not in this Node process.
 *
 * Design notes:
 * - Refs are handed out from an in-page `Map`, never written into the DOM. The
 *   user's real page is left byte-identical, and a ref can never be smuggled
 *   into a CSS selector.
 * - Every ref carries a per-document epoch. Navigation replaces `window`, so a
 *   stale ref fails to resolve instead of silently matching a different element.
 */

/** Root id of the (optional) agent overlay, excluded from every walk. */
export const OVERLAY_ROOT_ID = "__cb-agent-overlay-root";

/** Refs look like `k3f9a1-e12`. Anything else is rejected before it reaches a page. */
export const REF_PATTERN = /^[a-z0-9]{4,10}-e\d+$/;

const HELPERS = `
const OVERLAY_ID = ${JSON.stringify(OVERLAY_ROOT_ID)};
const store = window.__cbref || (window.__cbref = {
  n: 0,
  epoch: Math.random().toString(36).slice(2, 8),
  map: new Map(),
  ids: new WeakMap(),
});

// Mirrors the field classes Codex redacts: anything that could hold a secret,
// a one-time code or a direct identifier never reaches the model transcript.
const SENSITIVE = /user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\\botp\\b|\\b(?:2fa|mfa)\\b|phone|mobile|\\btel\\b|credit|card|\\bcvv\\b|\\bcvc\\b|\\bssn\\b|secret|token|api[-_ ]?key|\\bcc-(?:number|csc|exp|name|type)|card[-_ ]?number|\\bpan\\b|iban|account[-_ ]?number/i;

const tag = (el) => (el.localName || el.nodeName || "").toLowerCase();

function sensitive(el) {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password") return true;
  // Every WHATWG payment autofill token starts with cc-.
  if ((el.getAttribute("autocomplete") || "").trim().toLowerCase().startsWith("cc-")) return true;
  const probe = ["type", "autocomplete", "id", "name", "placeholder", "aria-label", "title"]
    .map((attr) => el.getAttribute(attr) || "")
    .join(" ");
  return SENSITIVE.test(probe);
}

/**
 * Definitively hidden: no descendant can be visible either, so the walker may
 * prune here. Deliberately excludes geometry — display:contents and zero-height
 * layout wrappers have no box of their own but do render their children.
 */
function hidden(el) {
  const style = getComputedStyle(el);
  if (style.visibility !== "visible" || style.display === "none") return true;
  if (Number(style.opacity) <= 0.01) return true;
  return el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden");
}

/** Has at least one box intersecting the viewport, so it is worth reporting. */
function onScreen(el) {
  // pointer-events:none is how overlays opt out of both hit-testing and snapshots.
  if (getComputedStyle(el).pointerEvents === "none") return false;
  for (const rect of el.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth) return true;
  }
  return false;
}

function role(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().toLowerCase();
  const name = tag(el);
  if (name === "a") return el.hasAttribute("href") ? "link" : "generic";
  if (name === "button") return "button";
  if (name === "select") return "combobox";
  if (name === "textarea") return "textbox";
  if (name === "img") return "image";
  if (name === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    if (type === "range") return "slider";
    if (type === "file") return "file-input";
    return "textbox";
  }
  if (/^h[1-6]$/.test(name)) return "heading";
  if (["nav", "main", "header", "footer", "form", "table", "ul", "ol", "li", "dialog", "summary", "option"].includes(name)) return name;
  return "generic";
}

// textContent avoids the synchronous layout that innerText forces on every node.
function shallowText(el, limit) {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
    else if (node.nodeType === Node.ELEMENT_NODE && !["script", "style"].includes(tag(node))) out += node.textContent || "";
    if (out.length >= limit) break;
  }
  return out.replace(/\\s+/g, " ").trim().slice(0, limit);
}

function labelFor(el) {
  const id = el.getAttribute("id");
  if (id) {
    const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (label) return shallowText(label, 160);
  }
  const wrapper = el.closest("label");
  return wrapper ? shallowText(wrapper, 160) : "";
}

function name(el) {
  const labelledBy = el.getAttribute("aria-labelledby");
  const candidates = [
    el.getAttribute("aria-label"),
    labelledBy ? labelledBy.split(/\\s+/).map((part) => { const t = document.getElementById(part); return t ? shallowText(t, 160) : ""; }).join(" ") : "",
    labelFor(el),
    el.getAttribute("placeholder"),
    el.getAttribute("alt"),
    el.getAttribute("title"),
    ["submit", "button", "reset"].includes((el.getAttribute("type") || "").toLowerCase()) ? el.getAttribute("value") : "",
    shallowText(el, 160),
    el.getAttribute("name"),
  ];
  for (const candidate of candidates) {
    const text = (candidate || "").replace(/\\s+/g, " ").trim();
    if (text) return text.slice(0, 160);
  }
  return "";
}

function interactive(el) {
  if (el.matches("a[href], button, input, select, textarea, summary, [contenteditable=''], [contenteditable='true']")) return true;
  if (el.hasAttribute("onclick") || Number(el.getAttribute("tabindex") ?? -1) >= 0) return true;
  const r = el.getAttribute("role");
  return !!r && ["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "option", "switch", "textbox", "combobox", "searchbox", "slider"].includes(r.trim().toLowerCase());
}

function state(el) {
  const bits = [];
  if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
  if (el.checked || el.getAttribute("aria-checked") === "true") bits.push("checked");
  const expanded = el.getAttribute("aria-expanded");
  if (expanded) bits.push("expanded=" + expanded);
  if (el.getAttribute("aria-selected") === "true") bits.push("selected");
  if ("value" in el && el.value) {
    bits.push(sensitive(el) ? "value=<redacted>" : "value=" + JSON.stringify(String(el.value).slice(0, 80)));
  }
  return bits.length ? " [" + bits.join(" ") + "]" : "";
}

// An element keeps the same id for the document's lifetime, and ids are never
// reused. Clearing only the lookup map means a ref from an earlier snapshot
// fails loudly instead of resolving to whatever now occupies that index.
function assignRef(el) {
  let id = store.ids.get(el);
  if (id === undefined) {
    id = ++store.n;
    store.ids.set(el, id);
  }
  const ref = store.epoch + "-e" + id;
  store.map.set(ref, el);
  return ref;
}
`;

/** Builds a compact, ref-annotated outline of everything visible in the viewport. */
export const SNAPSHOT_SCRIPT = `(() => {
${HELPERS}
store.map.clear();

// A click that triggers navigation can leave the document without a body for a
// few frames. Report that rather than throwing, so the caller can retry.
if (!document.body) {
  return JSON.stringify({ url: location.href, title: document.title, snapshot: "(page is still loading)", truncated: false, loading: true, epoch: store.epoch });
}

const SKIP = new Set(["script", "style", "noscript", "svg", "head", "template", "link", "meta"]);
const lines = [];
let truncated = false;
let visited = 0;

const walk = (node, depth) => {
  for (const el of node.children) {
    if (truncated) return;
    if (SKIP.has(tag(el)) || el.id === OVERLAY_ID) continue;
    const fileInput = tag(el) === "input" && (el.getAttribute("type") || "").toLowerCase() === "file";
    // Only prune on definitive hiding. Geometry decides what to *emit*, never
    // what to descend into, or display:contents wrappers would hide whole apps.
    if (hidden(el) && !fileInput) continue;
    if (++visited > 20000) { truncated = true; return; }

    let nextDepth = depth;
    if (onScreen(el) || fileInput) {
      const r = role(el);
      const structural = ["heading", "nav", "main", "form", "dialog", "table", "li"].includes(r);
      // Images only earn a line when they carry an accessible name, otherwise
      // decorative spacers would flood the snapshot.
      const named = r === "image" && !!name(el);
      if (interactive(el) || structural || named) {
        const label = name(el);
        const href = tag(el) === "a" && el.getAttribute("href") ? " href=" + JSON.stringify(el.getAttribute("href").slice(0, 120)) : "";
        const offscreen = fileInput && !onScreen(el) ? " [hidden]" : "";
        lines.push("  ".repeat(depth) + "- " + r + (label ? " " + JSON.stringify(label) : "") + " [ref=" + assignRef(el) + "]" + state(el) + offscreen + href);
        nextDepth = depth + 1;
      } else if (!el.children.length) {
        const text = shallowText(el, 200);
        if (text) lines.push("  ".repeat(depth) + "- text " + JSON.stringify(text));
      }
    }

    if (lines.length > 1500) { truncated = true; return; }
    if (el.shadowRoot) walk(el.shadowRoot, nextDepth);
    walk(el, nextDepth);
  }
};
walk(document.body, 0);

return JSON.stringify({
  url: location.href,
  title: document.title,
  snapshot: lines.join("\\n") || "(no visible content)",
  truncated,
  epoch: store.epoch,
});
})()`;

const STALE_REF_HINT = "Take a fresh browser_snapshot: refs are invalidated by navigation and by each new snapshot.";

/**
 * Resolves a ref to viewport coordinates and verifies the point actually hits
 * the intended element, so a sticky header or cookie banner cannot silently
 * swallow the click.
 */
export const RESOLVE_REF_SCRIPT = (ref: string) => `(() => {
  const store = window.__cbref;
  const el = store && store.map ? store.map.get(${JSON.stringify(ref)}) : undefined;
  if (!el) return JSON.stringify({ error: "Unknown ref. ${STALE_REF_HINT}" });
  if (!el.isConnected) return JSON.stringify({ error: "That element was removed from the page. ${STALE_REF_HINT}" });

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  // getClientRects handles inline elements that wrap across lines, where the
  // bounding box centre can fall in the gap between fragments.
  const clip = (r) => {
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, innerWidth);
    const bottom = Math.min(r.bottom, innerHeight);
    return right > left && bottom > top ? { left, top, right, bottom, area: (right - left) * (bottom - top) } : null;
  };
  let rect = null;
  for (const candidate of el.getClientRects()) {
    const visible = clip(candidate);
    if (visible && (!rect || visible.area > rect.area)) rect = visible;
  }
  if (!rect) rect = clip(el.getBoundingClientRect());
  if (!rect) return JSON.stringify({ error: "That element is not visible in the viewport." });

  const x = (rect.left + rect.right) / 2;
  const y = (rect.top + rect.bottom) / 2;
  const hit = document.elementFromPoint(x, y);
  const covered = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);

  return JSON.stringify({
    x, y,
    tag: (el.localName || "").toLowerCase(),
    type: (el.getAttribute("type") || "").toLowerCase(),
    covered,
    coveredBy: covered ? (hit.localName || "") + (hit.id ? "#" + hit.id : "") : "",
  });
})()`;

/** Extracts readable page text, stripped of chrome and scripts. */
export const TEXT_SCRIPT = `(() => {
  if (!document.body) return JSON.stringify({ url: location.href, title: document.title, text: "", loading: true });
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, svg, #" + CSS.escape(${JSON.stringify(OVERLAY_ROOT_ID)})).forEach((el) => el.remove());
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: (clone.innerText || clone.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim(),
  });
})()`;

/** Selects everything in the focused field, including contenteditable hosts. */
export const SELECT_ALL_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el) return JSON.stringify({ ok: false });
  try {
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return JSON.stringify({ ok: true, mode: "range" });
    }
    if (typeof el.select === "function") { el.select(); return JSON.stringify({ ok: true, mode: "select" }); }
  } catch {
    return JSON.stringify({ ok: false });
  }
  return JSON.stringify({ ok: false });
})()`;

/**
 * Overlays a badge on the page favicon so the tab strip shows that automation
 * is live, even when the tab is in the background. Swaps `<link rel=icon>`
 * hrefs only — no new DOM nodes, so snapshots are unaffected.
 */
export const FAVICON_BADGE_SCRIPT = (active: boolean) => `(() => {
  const ATTR = "data-cb-icon";
  const head = document.head;
  if (!head) return JSON.stringify({ ok: false });
  let links = [...head.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')];

  if (!${JSON.stringify(active)}) {
    for (const link of links) {
      const original = link.getAttribute(ATTR);
      if (original === null) continue;
      if (original === "") link.remove();
      else link.setAttribute("href", original);
      link.removeAttribute(ATTR);
    }
    return JSON.stringify({ ok: true, restored: true });
  }

  if (!links.length) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute(ATTR, "");
    head.appendChild(link);
    links = [link];
  }

  const badge = '<circle cx="23" cy="23" r="8" fill="#10A37F" stroke="white" stroke-width="2"/>';
  for (const link of links) {
    if (link.getAttribute(ATTR) === null) link.setAttribute(ATTR, link.getAttribute("href") || "");
    const original = link.getAttribute(ATTR);
    const base = original
      ? '<image href="' + original.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '" width="32" height="32" opacity="0.35"/>'
      : '';
    link.setAttribute("href", "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' + base + badge + '</svg>'));
  }
  return JSON.stringify({ ok: true, count: links.length });
})()`;
