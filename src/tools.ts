import { z } from "zod";
import path from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hub } from "./hub.js";
import {
  FAVICON_BADGE_SCRIPT,
  REF_PATTERN,
  RESOLVE_REF_SCRIPT,
  SELECT_ALL_SCRIPT,
  SNAPSHOT_SCRIPT,
  TEXT_SCRIPT,
} from "./pagescript.js";
import { fenceUrlLines, oneLine } from "./report-text.js";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: Content[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolOptions {
  /** Badge the page favicon while a tab is attached, so the tab strip shows automation is live. */
  pageBadge: boolean;
}

interface KeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const PUNCTUATION: Record<string, [string, number]> = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };

/** Builds a CDP key descriptor, keeping `code` correct for digits and punctuation. */
function describeKey(key: string): KeyDescriptor {
  const named = NAMED_KEYS[key];
  if (named) return named;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    if (key >= "0" && key <= "9") return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
    const punctuation = PUNCTUATION[key];
    if (punctuation) return { key, code: punctuation[0], keyCode: punctuation[1], text: key };
    return { key, code: "", keyCode: key.charCodeAt(0), text: key };
  }
  return { key, code: key, keyCode: 0 };
}

/**
 * Refs are produced by our own snapshot script, but they travel through the
 * model — which reads untrusted page content — before coming back. Validating
 * the shape here keeps anything model-authored out of injected source.
 */
function assertRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`Invalid element ref ${JSON.stringify(ref)}. Refs come from browser_snapshot and look like "k3f9a1-e12".`);
  }
  return ref;
}

interface Point {
  x: number;
  y: number;
  tag: string;
  type: string;
  covered: boolean;
  coveredBy: string;
}

/** Thin wrapper that turns hub calls into CDP round-trips against the attached tab. */
class Browser {
  constructor(private readonly hub: Hub) {}

  async cdp<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return (await this.hub.call({ type: "cdp", method, params }, timeoutMs)) as T;
  }

  async command<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return (await this.hub.call({ type, ...payload })) as T;
  }

  /** Flashes the extension's toolbar badge. Never allowed to fail a real action. */
  markBusy() {
    void this.hub.call({ type: "busy" }, 5000).catch(() => {});
  }

  /**
   * Maps a snapshot epoch to the frame that issued it. Child frames evaluate in
   * their own isolated world and report coordinates relative to themselves, so
   * the offset of the owning <iframe> is stored alongside.
   */
  readonly frames = new Map<string, { contextId?: number; frameId?: string; ownerObjectId?: string; offsetX: number; offsetY: number }>();

  /** Evaluates a page expression that returns a JSON string, and parses it. */
  async evalJson<T>(expression: string, contextId?: number): Promise<T> {
    const response = await this.cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "page script failed");
    }
    return JSON.parse(response.result.value) as T;
  }

  async point(ref: string): Promise<Point> {
    assertRef(ref);
    const frame = this.frames.get(ref.split("-")[0]);
    const resolved = await this.evalJson<Point & { error?: string }>(RESOLVE_REF_SCRIPT(ref), frame?.contextId);
    if (resolved.error) throw new Error(resolved.error);
    if (!frame?.frameId) return resolved;

    // scrollIntoView inside a frame scrolls the parent too, so the offset
    // captured at snapshot time is stale by the parent's scroll delta.
    const offset = await this.frameOffset(frame.frameId).catch(() => null);
    const dx = offset?.x ?? frame.offsetX;
    const dy = offset?.y ?? frame.offsetY;
    return { ...resolved, x: resolved.x + dx, y: resolved.y + dy };
  }

  /** Current viewport-relative origin of a child frame's owning <iframe>. */
  private async frameOffset(frameId: string): Promise<{ x: number; y: number }> {
    const owner = await this.cdp("DOM.getFrameOwner", { frameId });
    const node = await this.cdp("DOM.resolveNode", { backendNodeId: owner.backendNodeId });
    const objectId = node?.object?.objectId;
    if (!objectId) throw new Error("frame owner unavailable");
    try {
      const rect = await this.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){const r=this.getBoundingClientRect();return JSON.stringify({x:r.left+this.clientLeft,y:r.top+this.clientTop});}",
        returnByValue: true,
      });
      if (rect?.exceptionDetails) throw new Error("frame owner rect unavailable");
      return JSON.parse(rect.result.value);
    } finally {
      await this.cdp("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  /** Execution context that issued a ref, so frame-scoped tools evaluate in the right world. */
  contextFor(ref: string): number | undefined {
    return this.frames.get(ref.split("-")[0])?.contextId;
  }

  /**
   * The main frame's address as Chrome records it. Unlike `location.href` read
   * by page-world script, the page cannot forge it (saarathi#46).
   */
  async mainFrameUrl(): Promise<string> {
    const tree = await this.cdp("Page.getFrameTree", {});
    const url = tree?.frameTree?.frame?.url;
    if (typeof url !== "string" || !url) throw new Error("main frame URL unavailable");
    return url;
  }

  /** Enumerates child frames and snapshots each one in its own isolated world. */
  async frameSnapshots(): Promise<string[]> {
    let tree: any;
    try {
      tree = await this.cdp("Page.getFrameTree", {});
    } catch {
      return [];
    }
    const children: { frameId: string; url: string }[] = [];
    const collect = (node: any, depth: number) => {
      for (const child of node.childFrames ?? []) {
        const url = child.frame?.url ?? "";
        if (/^https?:/i.test(url)) children.push({ frameId: child.frame.id, url });
        // Nested frames need offset accumulation before they can be clicked safely.
        if (depth < 0) collect(child, depth + 1);
      }
    };
    collect(tree.frameTree, 0);

    const blocks: string[] = [];
    for (const { frameId, url } of children.slice(0, 8)) {
      try {
        // The <iframe> position must be viewport-relative, because that is what
        // Input.dispatchMouseEvent expects. Box-model quads are document-relative,
        // so a scrolled page would send clicks to the wrong element.
        const owner = await this.cdp("DOM.getFrameOwner", { frameId });
        const node = await this.cdp("DOM.resolveNode", { backendNodeId: owner.backendNodeId });
        if (!node?.object?.objectId) continue;
        let rect: any;
        try {
          rect = await this.cdp("Runtime.callFunctionOn", {
            objectId: node.object.objectId,
            functionDeclaration:
              "function(){const r=this.getBoundingClientRect();return JSON.stringify({x:r.left+this.clientLeft,y:r.top+this.clientTop});}",
            returnByValue: true,
          });
        } finally {
          await this.cdp("Runtime.releaseObject", { objectId: node.object.objectId }).catch(() => {});
        }
        if (rect?.exceptionDetails) throw new Error("frame owner rect unavailable");
        const quad = JSON.parse(rect.result.value);
        const world = await this.cdp("Page.createIsolatedWorld", { frameId, worldName: "chrome-bridge" });
        const page = await this.evalJson<{ snapshot: string; epoch: string; url: string }>(SNAPSHOT_SCRIPT, world.executionContextId);
        this.frames.set(page.epoch, { contextId: world.executionContextId, frameId, offsetX: quad.x, offsetY: quad.y });
        const indented = page.snapshot.split("\n").map((line) => "  " + line).join("\n");
        blocks.push(`- iframe ${JSON.stringify(url.slice(0, 120))}\n${indented}`);
      } catch {
        blocks.push(`- iframe ${JSON.stringify(url.slice(0, 120))}\n  (content not reachable from this frame)`);
      }
    }
    return blocks;
  }

  async mouse(type: string, x: number, y: number, clickCount = 0, button = "left") {
    await this.dispatchInput("Input.dispatchMouseEvent", { type, x, y, button, clickCount, buttons: type === "mousePressed" ? 1 : 0 });
  }

  /**
   * Dispatches an input event, tolerating a modal JavaScript dialog.
   *
   * A click that opens alert/confirm/prompt never returns from CDP until the
   * dialog is handled, so awaiting it naively hangs the tool for the full hub
   * timeout. If the call stalls, poll for a dialog and return once one is open —
   * the input itself has already been delivered.
   */
  private async dispatchInput(method: string, params: Record<string, unknown>) {
    let settled = false;
    const call = this.cdp(method, params, 30_000)
      .then((result) => {
        settled = true;
        return result;
      })
      .catch(() => {
        settled = true;
      });

    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, 600))]);
    if (settled) return;

    for (let attempt = 0; attempt < 24 && !settled; attempt++) {
      if (await this.dialog()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await call;
  }

  async clickAt(x: number, y: number, clickCount = 1, button = "left") {
    this.markBusy();
    await this.mouse("mouseMoved", x, y, 0, "none");
    await this.mouse("mousePressed", x, y, clickCount, button);
    await this.mouse("mouseReleased", x, y, clickCount, button);
  }

  async pressKey(key: string, modifiers: string[] = []) {
    this.markBusy();
    const bits = modifiers.reduce((acc, name) => acc | (MODIFIER_BITS[name] ?? 0), 0);
    const descriptor = describeKey(key);
    const base = {
      modifiers: bits,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
    };
    // Suppress `text` when a non-shift modifier is held so shortcuts are not typed as characters.
    const typed = bits & ~MODIFIER_BITS.Shift ? undefined : descriptor.text;
    await this.dispatchInput("Input.dispatchKeyEvent", { ...base, type: typed ? "keyDown" : "rawKeyDown", text: typed });
    await this.dispatchInput("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  /** Centre of the visual viewport, in CSS pixels. */
  async viewportCentre(): Promise<{ x: number; y: number }> {
    try {
      const metrics = await this.cdp("Page.getLayoutMetrics", {});
      const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
      return { x: (viewport.clientWidth ?? 800) / 2, y: (viewport.clientHeight ?? 600) / 2 };
    } catch {
      return { x: 400, y: 300 };
    }
  }

  /** Returns the open JavaScript dialog for the attached tab, if any. */
  async dialog(): Promise<{ type: string; message: string } | null> {
    const state = await this.command<{ dialog?: { type: string; message: string } | null }>("navState").catch(() => null);
    return state?.dialog ?? null;
  }

  /** Brings the attached tab to the front; input is ignored by inactive tabs. */
  async focus() {
    await this.command("focusTab").catch(() => {});
  }

  /** Tags the current document so a subsequent navigation can be detected. */
  private async awaitNavigationStart(after: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const state = await this.command<{ startedAt: number; pending: boolean }>("navState").catch(() => null);
      if (state && (state.pending || state.startedAt >= after)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async awaitNavigationEnd(budgetMs: number) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const state = await this.command<{ pending: boolean }>("navState").catch(() => null);
      if (!state || !state.pending) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await this.settleNavigation();
  }

  /**
   * Runs an interaction and then waits correctly. Navigation is detected from
   * real CDP frame lifecycle events rather than by polling the document, because
   * a cross-origin navigation keeps the old document alive until the new
   * response arrives — often well over a second.
   */
  async actAndSettle(action: () => Promise<void>) {
    const start = Date.now();
    await action();
    if (await this.awaitNavigationStart(start, 900)) await this.awaitNavigationEnd(20_000);
    else await this.settle(200);
  }

  /**
   * Waits out an in-flight navigation so a snapshot describes the page that is
   * arriving rather than the one being replaced. Bounded, and tolerant of the
   * execution context being swapped mid-navigation.
   */
  async settleNavigation(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let state: string | undefined;
      try {
        const response = await this.cdp("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, 5000);
        state = response?.result?.value;
      } catch {
        state = undefined;
      }
      if (state && state !== "loading") return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async settle(ms = 350) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

/**
 * Indents every `URL:` line a result carries except line 1 of its first text
 * item, where snapshot and browser_text put the address from Chrome. Page text
 * reaches results through titles, ids, bodies and error messages; this keeps
 * all of it from adding an address line a consumer would trust (saarathi#46).
 */
function fenceResult(result: ToolResult): ToolResult {
  let first = true;
  result.content = result.content.map((item) => {
    if (item.type !== "text") return item;
    const fenced = { ...item, text: fenceUrlLines(item.text, first ? 1 : 0) };
    first = false;
    return fenced;
  });
  return result;
}

/** Wraps a handler so thrown errors become MCP tool errors instead of transport failures. */
function guard(handler: (args: any) => Promise<ToolResult>) {
  return async (args: any): Promise<ToolResult> => {
    try {
      return fenceResult(await handler(args));
    } catch (error) {
      return fenceResult({ content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true });
    }
  };
}

export function registerTools(server: McpServer, hub: Hub, options: ToolOptions = { pageBadge: true }) {
  const browser = new Browser(hub);

  const setPageBadge = (active: boolean) => {
    if (!options.pageBadge) return;
    void browser.evalJson(FAVICON_BADGE_SCRIPT(active)).catch(() => {});
  };

  /** Appends any browser-state notifications the extension pushed since the last tool call. */
  const withNotifications = (result: ToolResult): ToolResult => {
    const notes = hub.drainNotifications();
    if (notes.length) result.content.push({ type: "text", text: `\n[Browser notifications]\n${notes.join("\n")}` });
    return result;
  };

  const snapshot = async (label: string, extra?: string): Promise<ToolResult> => {
    type Page = { url: string; title: string; snapshot: string; truncated: boolean; loading?: boolean; epoch: string };

    // A modal JS dialog blocks Runtime.evaluate entirely; without this the next
    // snapshot would hang until the hub timeout instead of saying why.
    const pending = await browser.dialog();
    if (pending) {
      return withNotifications(
        text(
          `${label}\n\nA ${pending.type} dialog is open and blocking the page: ${JSON.stringify(pending.message)}.\n` +
            `Call browser_handle_dialog to accept or dismiss it before inspecting the page.`,
        ),
      );
    }
    await browser.settleNavigation();
    let page = await browser.evalJson<Page>(SNAPSHOT_SCRIPT);
    // A click or submit that navigates can leave the document bodyless briefly.
    for (let retry = 0; page.loading && retry < 3; retry++) {
      await browser.settle(500);
      page = await browser.evalJson<Page>(SNAPSHOT_SCRIPT);
    }

    browser.frames.clear();
    browser.frames.set(page.epoch, { offsetX: 0, offsetY: 0 });
    const frameBlocks = await browser.frameSnapshots();
    const url = await browser.mainFrameUrl();
    // Re-applied after every action because navigation resets the page's icon links.
    setPageBadge(true);
    // URL: is line 1 and comes from Chrome; guard() fences any later URL: line.
    return withNotifications(
      text(
        [
          `URL: ${url}`,
          `Title: ${oneLine(page.title)}`,
          oneLine(label),
          extra && oneLine(extra),
          "",
          "Page snapshot (use [ref=...] values with browser_click / browser_type):",
          page.snapshot,
          frameBlocks.length ? frameBlocks.join("\n") : "",
          page.truncated ? "\n(snapshot truncated — scroll or narrow the view for more)" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  };

  const coverageWarning = (point: Point, ref: string) =>
    point.covered ? `Warning: ref=${ref} is overlapped by <${point.coveredBy}> at the click point; the click may have hit that instead.` : undefined;

  server.registerTool(
    "browser_tabs",
    {
      title: "List browser tabs",
      description:
        "List every open tab in the user's running Chrome, across all windows. Returns tab ids, titles and URLs. " +
        "Call this first to find the tab you want, then use browser_attach. Tabs marked '+' are also being debugged by " +
        "DevTools or another automation extension (Codex/ChatGPT, Claude in Chrome) — that is fine, Chrome lets debugger " +
        "sessions share a tab. Requires no page permissions and does not change any state.",
      inputSchema: {},
    },
    guard(async () => {
      const tabs = await browser.command<any[]>("listTabs");
      if (!tabs.length) return text("No open tabs found.");
      const marker = (tab: any) => (tab.attached ? "*" : tab.shared ? "+" : " ");
      const lines = tabs.map(
        (tab) =>
          `${marker(tab)} [${tab.id}] (window ${tab.windowId}) ${tab.active ? "(active) " : ""}${oneLine(tab.title || "(untitled)")}\n      ${tab.url}`,
      );
      const shared = tabs.some((tab) => tab.shared);
      const legend = `Open Chrome tabs ("*" = attached to us${shared ? `, "+" = also debugged by another client` : ""}):`;
      return withNotifications(text(`${legend}\n${lines.join("\n")}`));
    }),
  );

  server.registerTool(
    "browser_attach",
    {
      title: "Attach to a tab",
      description:
        "Attach the debugger to one of the user's existing Chrome tabs so it can be inspected and controlled. " +
        "This is how you reuse the user's logged-in sessions and cookies. Pass a tabId from browser_tabs, or omit it to attach to the active tab. " +
        "Chrome shows a visible 'being debugged' banner while attached; use browser_detach when finished.",
      inputSchema: {
        tabId: z.number().int().optional().describe("Tab id from browser_tabs. Omit to use the currently active tab."),
      },
    },
    guard(async ({ tabId }) => {
      const info = await browser.command<{ id: number; title: string; url: string }>("attach", { tabId });
      return snapshot(`Attached to tab ${info.id}.`);
    }),
  );

  server.registerTool(
    "browser_new_tab",
    {
      title: "Open a new tab",
      description:
        "Open a new Chrome tab, attach to it, and return a snapshot of the loaded page. " +
        "Agent-created tabs are placed in a labelled tab group so the user can tell them apart from their own.",
      inputSchema: {
        url: z.string().describe("URL to open, e.g. https://example.com"),
        background: z.boolean().optional().describe("Open without focusing the tab. Defaults to false."),
      },
    },
    guard(async ({ url, background }) => {
      const info = await browser.command<{ id: number }>("newTab", { url, active: !background });
      await browser.settle(500);
      return snapshot(`Opened ${url} in tab ${info.id}.`);
    }),
  );

  server.registerTool(
    "browser_new_window",
    {
      title: "Open an owned Chrome window",
      description:
        "Create a new normal Chrome window in this profile, open the requested URL, and attach this MCP client to it. " +
        "The returned windowId is owned by this MCP client and may be closed with browser_close_window.",
      inputSchema: {
        url: z.string().describe("HTTP(S) URL to open in the new window."),
        background: z.boolean().optional().describe("Open without focusing the new window. Defaults to false."),
      },
    },
    guard(async ({ url, background }) => {
      const info = await browser.command<{ id: number; windowId: number; title: string; url: string }>("newWindow", {
        url,
        active: !background,
      });
      return snapshot(`Opened owned Chrome window ${info.windowId} with tab ${info.id}.`);
    }),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate",
      description:
        "Navigate the attached tab. Use action 'goto' with a url, or 'back' / 'forward' / 'reload'. " +
        "Avoid calling goto with the URL the tab is already on — that reloads the page and can discard in-progress form state.",
      inputSchema: {
        action: z.enum(["goto", "back", "forward", "reload"]).default("goto").describe("Navigation action."),
        url: z.string().optional().describe("Target URL, required when action is 'goto'."),
      },
    },
    guard(async ({ action, url }) => {
      browser.markBusy();
      const before = await browser.mainFrameUrl().catch(() => "");

      if (action === "goto") {
        if (!url) throw new Error("`url` is required when action is 'goto'.");
        const result = await browser.cdp("Page.navigate", { url });
        if (result?.errorText && result.errorText !== "net::ERR_ABORTED") {
          throw new Error(`Navigation failed: ${result.errorText}`);
        }
      } else if (action === "reload") {
        await browser.cdp("Page.reload", {});
      } else {
        const history = await browser.cdp("Page.getNavigationHistory", {});
        const index = history.currentIndex + (action === "back" ? -1 : 1);
        const entry = history.entries[index];
        if (!entry) throw new Error(`Cannot go ${action}: no such history entry.`);
        await browser.cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
      }

      await browser.settleNavigation();
      await browser.settle(400);
      const after = await browser.mainFrameUrl().catch(() => "");

      // A URL serving an attachment downloads instead of navigating; saying
      // "complete" while the page never moved sends the agent down a dead end.
      const stalled = action === "goto" && !!url && after === before && !after.startsWith(url);
      const note = stalled
        ? `Note: the page did not navigate — it is still on ${after}. ${url} most likely triggered a file download instead of rendering. Check the browser notifications for the saved path.`
        : undefined;

      return snapshot(`Navigation (${action}) complete.`, note);
    }),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot the page",
      description:
        "Return a structured, ref-annotated outline of everything currently visible in the attached tab. " +
        "This is the cheapest way to understand page state and is the preferred input for clicking and typing. " +
        "Each snapshot issues fresh refs and invalidates earlier ones, so always act on the most recent snapshot.",
      inputSchema: {},
    },
    guard(() => snapshot("Current page state.")),
  );

  server.registerTool(
    "browser_text",
    {
      title: "Read page text",
      description: "Return the readable text content of the attached tab, with scripts and styles stripped. Use when you need prose rather than structure.",
      inputSchema: {
        maxChars: z.number().int().positive().optional().describe("Truncate output to this many characters. Defaults to 20000."),
      },
    },
    guard(async ({ maxChars }) => {
      const limit = maxChars ?? 20_000;
      const page = await browser.evalJson<{ title: string; text: string }>(TEXT_SCRIPT);
      const url = await browser.mainFrameUrl();
      const body = page.text.length > limit ? `${page.text.slice(0, limit)}\n… (truncated)` : page.text;
      return withNotifications(text(`URL: ${url}\nTitle: ${oneLine(page.title)}\n\n${body}`));
    }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot",
      description:
        "Capture a PNG screenshot of the attached tab. Use it when visual confirmation matters; prefer browser_snapshot when you only need structure.",
      inputSchema: {
        fullPage: z.boolean().optional().describe("Capture the full scrollable page instead of the viewport. Defaults to false."),
      },
    },
    guard(async ({ fullPage }) => {
      const result = await browser.cdp(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: !!fullPage },
        60_000,
      );
      return withNotifications({
        content: [
          { type: "text", text: fullPage ? "Full-page screenshot:" : "Viewport screenshot:" },
          { type: "image", data: result.data, mimeType: "image/png" },
        ],
      });
    }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click",
      description:
        "Click an element in the attached tab. Prefer `ref` from browser_snapshot; fall back to raw `x`/`y` viewport coordinates when no ref fits (for example canvas or map surfaces). " +
        "Clicks are dispatched through the debugger as real trusted input events, so sites that reject synthetic events still work.",
      inputSchema: {
        ref: z.string().optional().describe("Element ref from browser_snapshot, e.g. 'k3f9a1-e12'."),
        x: z.number().optional().describe("Viewport x coordinate. Only used when ref is omitted."),
        y: z.number().optional().describe("Viewport y coordinate. Only used when ref is omitted."),
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Defaults to left."),
        doubleClick: z.boolean().optional().describe("Send a double click. Defaults to false."),
      },
    },
    guard(async ({ ref, x, y, button, doubleClick }) => {
      await browser.focus();
      let target: Point | { x: number; y: number } = { x: x ?? 0, y: y ?? 0 };
      let warning: string | undefined;

      if (ref) {
        const point = await browser.point(ref);
        target = point;
        warning = coverageWarning(point, ref);
      } else if (x === undefined || y === undefined) {
        throw new Error("Provide either `ref` or both `x` and `y`.");
      }

      await browser.actAndSettle(() => browser.clickAt(target.x, target.y, doubleClick ? 2 : 1, button ?? "left"));
      return snapshot(`Clicked ${ref ? `ref=${ref}` : `(${target.x}, ${target.y})`}.`, warning);
    }),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description:
        "Focus a field and type into it. Pass a `ref` from browser_snapshot to click the field first. " +
        "Set `clear` to replace existing content, and `submit` to press Enter afterwards. " +
        "Set `perKey` for inputs that only react to real keystrokes, such as autocomplete and @-mention menus.",
      inputSchema: {
        text: z.string().describe("Text to type."),
        ref: z.string().optional().describe("Element ref to focus first. Omit to type into whatever currently has focus."),
        clear: z.boolean().optional().describe("Select and replace existing content first. Defaults to false."),
        submit: z.boolean().optional().describe("Press Enter after typing. Defaults to false."),
        perKey: z.boolean().optional().describe("Send one key event per character instead of a single insert. Slower, but triggers keystroke-driven UI."),
      },
    },
    guard(async ({ text: value, ref, clear, submit, perKey }) => {
      await browser.focus();
      let warning: string | undefined;
      if (ref) {
        const point = await browser.point(ref);
        warning = coverageWarning(point, ref);
        await browser.clickAt(point.x, point.y);
        await browser.settle(120);
      }

      if (clear) {
        // Ctrl/Meta+A works for inputs and contenteditable hosts alike; the page
        // script is only a fallback for editors that swallow the shortcut.
        await browser.pressKey("a", [process.platform === "darwin" ? "Meta" : "Control"]);
        const selected = await browser.evalJson<{ ok: boolean }>(SELECT_ALL_SCRIPT).catch(() => ({ ok: false }));
        if (!selected.ok) await browser.settle(60);
        await browser.pressKey("Delete");
      }

      browser.markBusy();
      await browser.actAndSettle(async () => {
        if (perKey) {
          for (const character of value) await browser.pressKey(character);
        } else {
          await browser.cdp("Input.insertText", { text: value });
        }
        if (submit) await browser.pressKey("Enter");
      });
      return snapshot(`Typed into ${ref ? `ref=${ref}` : "the focused element"}${submit ? " and submitted" : ""}.`, warning);
    }),
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press a key",
      description:
        "Press a single key in the attached tab, optionally with modifiers. Useful for Enter, Tab, Escape, arrows, and shortcuts such as Meta+A.",
      inputSchema: {
        key: z.string().describe("Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character."),
        modifiers: z.array(z.enum(["Alt", "Control", "Ctrl", "Meta", "Command", "Shift"])).optional().describe("Modifier keys to hold."),
      },
    },
    guard(async ({ key, modifiers }) => {
      await browser.focus();
      await browser.actAndSettle(() => browser.pressKey(key, modifiers ?? []));
      return snapshot(`Pressed ${[...(modifiers ?? []), key].join("+")}.`);
    }),
  );

  server.registerTool(
    "browser_scroll",
    {
      title: "Scroll",
      description: "Scroll the page or a specific element. Positive deltaY scrolls down, negative scrolls up.",
      inputSchema: {
        deltaY: z.number().optional().describe("Vertical scroll distance in pixels. Defaults to 600."),
        deltaX: z.number().optional().describe("Horizontal scroll distance in pixels. Defaults to 0."),
        ref: z.string().optional().describe("Scroll with the pointer over this element instead of the viewport centre."),
      },
    },
    guard(async ({ deltaY, deltaX, ref }) => {
      await browser.focus();
      const origin = ref ? await browser.point(ref) : await browser.viewportCentre();
      browser.markBusy();
      await browser.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: origin.x,
        y: origin.y,
        deltaX: deltaX ?? 0,
        deltaY: deltaY ?? 600,
      });
      await browser.settle(400);
      return snapshot("Scrolled.");
    }),
  );

  server.registerTool(
    "browser_select_option",
    {
      title: "Select a dropdown option",
      description: "Choose one or more options in a native <select> element identified by a snapshot ref.",
      inputSchema: {
        ref: z.string().describe("Ref of the <select> element from browser_snapshot."),
        values: z.array(z.string()).describe("Option values or visible labels to select."),
      },
    },
    guard(async ({ ref, values }) => {
      assertRef(ref);
      await browser.focus();
      let outcome!: { error?: string; selected?: string[] };
      await browser.actAndSettle(async () => {
        outcome = await browser.evalJson<{ error?: string; selected?: string[] }>(`(() => {
        const store = window.__cbref;
        const el = store && store.map ? store.map.get(${JSON.stringify(ref)}) : undefined;
        if (!el) return JSON.stringify({ error: "Unknown ref. Take a fresh browser_snapshot." });
        if ((el.localName || "").toLowerCase() !== "select") return JSON.stringify({ error: "That ref is a <" + el.localName + ">, not a <select>." });
        const wanted = ${JSON.stringify(values)};
        const selected = [];
        for (const option of el.options) {
          option.selected = wanted.includes(option.value) || wanted.includes(option.label) || wanted.includes((option.text || "").trim());
          if (option.selected) selected.push(option.value);
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return JSON.stringify({ selected });
      })()`, browser.contextFor(ref));
      });
      if (outcome.error) throw new Error(outcome.error);
      if (!outcome.selected?.length) throw new Error(`None of ${JSON.stringify(values)} matched an option in that select.`);
      browser.markBusy();
      return snapshot(`Selected ${JSON.stringify(outcome.selected)} in ref=${ref}.`);
    }),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover over an element",
      description:
        "Move the mouse over an element without clicking. Needed for menus, tooltips and controls that only appear on hover. " +
        "Returns a fresh snapshot so newly revealed content is visible.",
      inputSchema: {
        ref: z.string().optional().describe("Element ref from browser_snapshot."),
        x: z.number().optional().describe("Viewport x coordinate. Only used when ref is omitted."),
        y: z.number().optional().describe("Viewport y coordinate. Only used when ref is omitted."),
      },
    },
    guard(async ({ ref, x, y }) => {
      await browser.focus();
      let target: { x: number; y: number };
      if (ref) target = await browser.point(ref);
      else if (x === undefined || y === undefined) throw new Error("Provide either `ref` or both `x` and `y`.");
      else target = { x, y };

      browser.markBusy();
      await browser.mouse("mouseMoved", target.x, target.y, 0, "none");
      // Hover-driven UI usually animates in.
      await browser.settle(500);
      return snapshot(`Hovered ${ref ? `ref=${ref}` : `(${target.x}, ${target.y})`}.`);
    }),
  );

  server.registerTool(
    "browser_upload",
    {
      title: "Upload files",
      description:
        "Attach local files to a file input on the page, then submit the form as usual with browser_click. " +
        "Pass the ref of the file input (shown as `file-input` in the snapshot) and absolute paths on this machine.",
      inputSchema: {
        ref: z.string().describe("Ref of the file input from browser_snapshot."),
        files: z.array(z.string()).min(1).describe("Absolute paths of the files to attach."),
      },
    },
    guard(async ({ ref, files }) => {
      assertRef(ref);
      for (const file of files) {
        if (!path.isAbsolute(file)) throw new Error(`File path must be absolute: ${file}`);
        if (!existsSync(file)) throw new Error(`No such file: ${file}`);
      }
      await browser.focus();

      // A remote object handle is the reliable way to address the input; node
      // ids go stale as the DOM agent re-reads the document.
      const frameContext = browser.contextFor(ref);
      const handle = await browser.cdp("Runtime.evaluate", {
        expression: `window.__cbref && window.__cbref.map ? window.__cbref.map.get(${JSON.stringify(ref)}) : undefined`,
        returnByValue: false,
        ...(frameContext === undefined ? {} : { contextId: frameContext }),
      });
      const objectId = handle?.result?.objectId;
      if (!objectId) throw new Error("Unknown ref. Take a fresh browser_snapshot.");

      try {
        await browser.cdp("DOM.setFileInputFiles", { files, objectId });
      } finally {
        await browser.cdp("Runtime.releaseObject", { objectId }).catch(() => {});
      }
      await browser.settle(300);
      return snapshot(`Attached ${files.length} file(s) to ref=${ref}.`);
    }),
  );

  server.registerTool(
    "browser_wait_for",
    {
      title: "Wait for the page to change",
      description:
        "Block until the page reaches an expected state, instead of guessing how long to sleep. " +
        "Wait for `text` to appear, for `textGone` to disappear, or for a JavaScript `expression` to become truthy. " +
        "Use this after starting an async action rather than re-snapshotting in a loop.",
      inputSchema: {
        text: z.string().optional().describe("Wait until this text appears anywhere in the page."),
        textGone: z.string().optional().describe("Wait until this text is no longer present."),
        expression: z.string().optional().describe("Wait until this JavaScript expression evaluates truthy."),
        timeoutMs: z.number().int().positive().optional().describe("Give up after this many milliseconds. Defaults to 15000."),
      },
    },
    guard(async ({ text: wanted, textGone, expression, timeoutMs }) => {
      if (!wanted && !textGone && !expression) {
        throw new Error("Provide one of `text`, `textGone` or `expression`.");
      }
      const budget = timeoutMs ?? 15_000;
      const deadline = Date.now() + budget;
      const probe = expression
        ? `(() => { try { return !!(${expression}); } catch { return false; } })()`
        : `(() => { const t = document.body ? (document.body.innerText || "") : ""; ` +
          `return ${wanted ? `t.includes(${JSON.stringify(wanted)})` : `!t.includes(${JSON.stringify(textGone)})`}; })()`;

      for (;;) {
        const response = await browser
          .cdp("Runtime.evaluate", { expression: probe, returnByValue: true }, 10_000)
          .catch(() => null);
        if (response?.result?.value === true) {
          return snapshot(`Condition met after ${Math.round(budget - (deadline - Date.now()))}ms.`);
        }
        if (Date.now() >= deadline) {
          const describe = wanted ? `text ${JSON.stringify(wanted)} to appear` : textGone ? `text ${JSON.stringify(textGone)} to disappear` : "the expression to become truthy";
          throw new Error(`Timed out after ${budget}ms waiting for ${describe}.`);
        }
        await browser.settle(250);
      }
    }),
  );

  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate JavaScript",
      description:
        "Run a JavaScript expression in the attached tab and return its value. Use for reads that the snapshot cannot express. " +
        "Async expressions are awaited. Prefer the dedicated tools for interaction so that input stays trusted.",
      inputSchema: {
        expression: z.string().describe("JavaScript expression, e.g. `document.querySelectorAll('article').length`."),
      },
    },
    guard(async ({ expression }) => {
      const response = await browser.cdp("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (response?.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "evaluation failed");
      }
      return withNotifications(text(JSON.stringify(response.result.value ?? null, null, 2)));
    }),
  );

  server.registerTool(
    "browser_console",
    {
      title: "Read console output",
      description: "Return console messages and uncaught page errors captured from the attached tab since it was attached. Useful when debugging a local app.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Maximum number of entries to return. Defaults to 100."),
      },
    },
    guard(async ({ limit }) => {
      const logs = await browser.command<{ level: string; text: string; url?: string }[]>("consoleLogs", { limit: limit ?? 100 });
      if (!logs.length) return withNotifications(text("No console output captured."));
      return withNotifications(text(logs.map((entry) => `[${entry.level}] ${entry.text}${entry.url ? ` (${entry.url})` : ""}`).join("\n")));
    }),
  );

  server.registerTool(
    "browser_cdp",
    {
      title: "Raw Chrome DevTools Protocol",
      description:
        "Escape hatch: send an arbitrary Chrome DevTools Protocol command to the attached tab, e.g. 'Network.getAllCookies' or 'Emulation.setDeviceMetricsOverride'. " +
        "Prefer the higher-level tools. If you change page or browser state this way and leave it changed, tell the user what you changed.",
      inputSchema: {
        method: z.string().describe("CDP method name, e.g. 'Page.getLayoutMetrics'."),
        params: z.record(z.unknown()).optional().describe("CDP parameter object."),
      },
    },
    guard(async ({ method, params }) => {
      const result = await browser.cdp(method, params ?? {});
      return withNotifications(text(JSON.stringify(result ?? null, null, 2).slice(0, 40_000)));
    }),
  );

  server.registerTool(
    "browser_handle_dialog",
    {
      title: "Handle a JavaScript dialog",
      description:
        "Accept or dismiss an open alert / confirm / prompt. While a dialog is open the page cannot be inspected or " +
        "interacted with at all, so call this as soon as one is reported. For a prompt, pass `promptText` to supply the answer.",
      inputSchema: {
        accept: z.boolean().optional().describe("Accept (OK) when true, dismiss (Cancel) when false. Defaults to true."),
        promptText: z.string().optional().describe("Text to enter, for prompt dialogs only."),
      },
    },
    guard(async ({ accept, promptText }) => {
      await browser.command("handleDialog", { accept: accept !== false, promptText });
      await browser.settle(300);
      return snapshot(`Dialog ${accept === false ? "dismissed" : "accepted"}.`);
    }),
  );

  server.registerTool(
    "browser_close_tab",
    {
      title: "Close a tab",
      description: "Close a Chrome tab. Omit tabId to close the attached tab. Only close tabs this session opened unless the user asked otherwise.",
      inputSchema: { tabId: z.number().int().optional().describe("Tab id to close. Defaults to the attached tab.") },
    },
    guard(async ({ tabId }) => {
      if (tabId === undefined) setPageBadge(false);
      await browser.command("closeTab", { tabId });
      return withNotifications(text("Tab closed."));
    }),
  );

  server.registerTool(
    "browser_close_window",
    {
      title: "Close an owned Chrome window",
      description:
        "Close a Chrome window created by this MCP client with browser_new_window. " +
        "The bridge rejects window IDs this client does not own and refuses to close windows with another client's attached tab.",
      inputSchema: { windowId: z.number().int().describe("windowId returned by browser_new_window in this MCP session.") },
    },
    guard(async ({ windowId }) => {
      const result = await browser.command<{ ok: boolean; windowId: number }>("closeWindow", { windowId });
      return withNotifications(text(`Owned Chrome window ${result.windowId} closed.`));
    }),
  );

  server.registerTool(
    "browser_detach",
    {
      title: "Detach from the tab",
      description: "Detach the debugger, restore the page favicon and dismiss Chrome's 'being debugged' banner. Call this when browser work is finished.",
      inputSchema: {},
    },
    guard(async () => {
      // Restore the favicon while we can still reach the page.
      if (options.pageBadge) await browser.evalJson(FAVICON_BADGE_SCRIPT(false)).catch(() => {});
      await browser.command("detach");
      return text("Detached. Chrome is no longer being controlled.");
    }),
  );
}
