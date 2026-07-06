/**
 * Real-world end-to-end suite for chrome-bridge-mcp.
 *
 * Nothing here is mocked: a real Chrome runs the real extension, the real MCP
 * server speaks real stdio JSON-RPC, and every assertion is made against actual
 * browser state — real public websites over the real network for DOM complexity,
 * plus a real locally-served site for the cases a public page cannot guarantee
 * (submitted form values, JS dialogs, console output, shadow DOM, key counting).
 *
 * Usage: node test/e2e.mjs [port]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.argv[2] ?? "8801";

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];
let section = "";
const t0 = Date.now();

function heading(name) {
  section = name;
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

function ok(label) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}

function bad(label, detail) {
  failures.push({ section, label, detail });
  console.log(`  \x1b[31m✗ ${label}\x1b[0m`);
  if (detail) console.log(`      ${String(detail).replace(/\n/g, "\n      ").slice(0, 500)}`);
}

function check(label, condition, detail) {
  if (condition) ok(label);
  else bad(label, detail);
}

async function test(label, fn) {
  try {
    const detail = await fn();
    if (detail === false) bad(label, "assertion returned false");
    else ok(label);
  } catch (error) {
    bad(label, error?.message ?? error);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- real local site */

const PAGES = {
  "/form": `<!doctype html><html><head><title>Form</title></head><body>
    <h1>Form page</h1>
    <form id="f" onsubmit="event.preventDefault();out.textContent='sent:'+q.value+'|'+pick.value+'|'+agree.checked;">
      <label for="q">Query</label><input id="q" name="q" placeholder="Search terms">
      <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
      <label for="agree">Agree</label><input id="agree" type="checkbox">
      <button type="submit">Submit</button>
    </form>
    <p id="out">idle</p>
    <input id="pw" type="password" value="TOPSECRET-pw">
    <input id="otp" name="one-time-code" value="998877">
    <input id="mail" name="email" value="private@example.com">
    <div id="ghost" style="pointer-events:none;position:fixed;top:0;left:0;right:0;height:40px">GHOSTOVERLAY</div>
  </body></html>`,

  "/keys": `<!doctype html><html><head><title>Keys</title></head><body>
    <h1>Keys page</h1>
    <input id="k" placeholder="type here">
    <p id="count">0</p><p id="last">none</p><p id="combo">none</p>
    <script>
      let n=0;
      k.addEventListener('keydown', e => {
        n++; count.textContent=n; last.textContent=e.key+'/'+e.code;
        if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k') combo.textContent='shortcut';
      });
    </script>
  </body></html>`,

  "/dialogs": `<!doctype html><html><head><title>Dialogs</title></head><body>
    <h1>Dialogs page</h1>
    <button id="a" onclick="alert('hello alert')">Alert</button>
    <button id="c" onclick="out.textContent = confirm('proceed?') ? 'accepted' : 'dismissed'">Confirm</button>
    <p id="out">none</p>
  </body></html>`,

  "/shadow": `<!doctype html><html><head><title>Shadow</title></head><body>
    <h1>Shadow page</h1>
    <my-widget></my-widget>
    <p id="out">untouched</p>
    <script>
      customElements.define('my-widget', class extends HTMLElement {
        connectedCallback() {
          const r = this.attachShadow({mode:'open'});
          r.innerHTML = '<button id="inner">Shadow Button</button>';
          r.getElementById('inner').addEventListener('click', () => { document.getElementById('out').textContent='shadow-clicked'; });
        }
      });
    </script>
  </body></html>`,

  "/editable": `<!doctype html><html><head><title>Editable</title></head><body>
    <h1>Editable page</h1>
    <div id="ed" contenteditable="true" style="border:1px solid #999;padding:8px;min-height:40px">ORIGINAL CONTENT</div>
  </body></html>`,

  "/covered": `<!doctype html><html><head><title>Covered</title></head><body style="margin:0">
    <div style="position:fixed;top:0;left:0;right:0;height:120px;background:#c00;z-index:99">Sticky banner</div>
    <div style="height:40px"></div>
    <button id="hidden-btn" onclick="out.textContent='reached'">Buried Button</button>
    <p id="out" style="margin-top:200px">not-reached</p>
  </body></html>`,

  "/long": `<!doctype html><html><head><title>Long</title></head><body>
    <h1>TOPMARKER</h1><div style="height:4000px">scroll region</div><h2>BOTTOMMARKER</h2>
  </body></html>`,

  "/console": `<!doctype html><html><head><title>Console</title></head><body>
    <h1>Console page</h1>
    <script>
      console.log("LOGLINE-alpha");
      console.warn("WARNLINE-beta");
      console.error("ERRORLINE-gamma");
      setTimeout(() => { throw new Error("THROWNLINE-delta"); }, 50);
    </script>
  </body></html>`,

  "/hiddenupload": `<!doctype html><title>Hidden upload</title><body>
    <h1>Hidden upload</h1>
    <label for="fi" style="border:1px solid #333;padding:8px">Choose a file</label>
    <input id="fi" type="file" style="display:none"><p id="names">none</p>
    <script>fi.addEventListener('change',()=>names.textContent=[...fi.files].map(f=>f.name).join(','));</script></body>`,

  "/spa": `<!doctype html><title>SPA</title><body>
    <h1>SPA page</h1><button id="go" onclick="history.pushState({},'','/spa/detail'); app.innerHTML='<h2>DETAIL VIEW</h2>'">Open detail</button>
    <div id="app"><h2>LIST VIEW</h2></div></body>`,

  "/popup": `<!doctype html><title>Popup</title><body><h1>Popup page</h1>
    <a id="a" href="https://example.com" target="_blank">Open in new tab</a></body>`,

  "/child": `<!doctype html><title>Child</title><body style="margin:0;font:14px sans-serif">
    <div style="height:30px">child header</div>
    <button id="b" onclick="o.textContent='CHILD-CLICKED'">Child Button</button>
    <input id="i" placeholder="child field"><p id="o">child-idle</p></body>`,

  "/parent": `<!doctype html><title>Parent</title><body style="margin:0;font:14px sans-serif">
    <h1>Parent heading</h1>
    <button id="pb" onclick="po.textContent='PARENT-CLICKED'">Parent Button</button>
    <p id="po">parent-idle</p><div style="height:120px">spacer</div>
    <iframe id="f" src="/child" style="width:600px;height:240px;border:4px solid #333"></iframe></body>`,

  "/hover": `<!doctype html><title>Hover</title><body>
    <h1>Hover page</h1>
    <img id="pic" src="data:image/gif;base64,R0lGODlhZABkAIAAAMzMzP///yH5BAAAAAAALAAAAABkAGQAAAIvhI+py+0Po5y02ouz3rz7D4biSJbmiabqyrbuC8fyTNf2jef6zvf+DwwKh8SicQEAOw==" alt="Hover Target" style="width:100px;height:100px">
    <p id="cap" style="display:none">REVEALED CAPTION</p>
    <script>pic.addEventListener('mouseover',()=>cap.style.display='block');</script></body>`,

  "/slow": `<!doctype html><title>Slow</title><body>
    <h1>Slow page</h1><button id="go" onclick="setTimeout(()=>{const p=document.createElement('p');p.textContent='ARRIVED LATE';document.body.appendChild(p);},2500)">Start</button></body>`,

  "/upload": `<!doctype html><title>Upload</title><body>
    <h1>Upload page</h1><input id="fi" type="file"><p id="names">none</p>
    <script>fi.addEventListener('change',()=>names.textContent=[...fi.files].map(f=>f.name).join(','));</script></body>`,

  "/unicode": `<!doctype html><html><head><title>Unicode</title></head><body>
    <h1>Unicode page</h1><input id="u"><p id="len">0</p>
    <script>u.addEventListener('input', () => len.textContent = String([...u.value].length));</script>
  </body></html>`,
};

const server = http.createServer((req, res) => {
  const page = PAGES[new URL(req.url, "http://x").pathname];
  if (!page) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const LOCAL = `http://127.0.0.1:${server.address().port}`;

/* -------------------------------------------------------------- mcp client */

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js"), "--port", PORT],
    stderr: "inherit",
  }),
);

async function raw(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: !!result.isError,
    text: result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"),
    image: result.content.find((p) => p.type === "image"),
  };
}

/** Calls a tool and throws if it errored — most tests want the happy path. */
async function call(name, args = {}) {
  const r = await raw(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text.slice(0, 300)}`);
  return r;
}

/** Reads a live value out of the page, unquoted. */
async function evalPage(expression) {
  const r = await call("browser_evaluate", { expression });
  return JSON.parse(r.text);
}

const refFor = (snapshot, pattern) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  return line?.match(/\[ref=([a-z0-9]+-e\d+)\]/)?.[1];
};

console.log(`\x1b[1mchrome-bridge-mcp — real end-to-end suite\x1b[0m`);
console.log(`bridge port ${PORT} · local site ${LOCAL}`);

/* ============================================================ 1. connection */

heading("1. Bridge and extension");

let connected = false;
for (let attempt = 0; attempt < 30; attempt++) {
  if (!(await raw("browser_tabs")).isError) {
    connected = true;
    break;
  }
  await sleep(1000);
}
check("extension connects to the bridge", connected);
if (!connected) {
  console.log("\nCannot continue without the extension. Is Chrome running with it loaded?");
  process.exit(1);
}

await test("server advertises exactly the 21 documented tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "browser_attach", "browser_cdp", "browser_click", "browser_close_tab", "browser_console",
    "browser_detach", "browser_evaluate", "browser_handle_dialog", "browser_hover", "browser_navigate", "browser_new_tab",
    "browser_press_key", "browser_screenshot", "browser_scroll", "browser_select_option",
    "browser_snapshot", "browser_tabs", "browser_text", "browser_type", "browser_upload",
    "browser_wait_for",
  ];
  if (names.join(",") !== expected.join(",")) throw new Error(`got: ${names.join(",")}`);
  for (const tool of tools) {
    if (!tool.description || tool.description.length < 40) throw new Error(`${tool.name} lacks a usable description`);
  }
});

await test("tools are rejected before any tab is attached", async () => {
  const r = await raw("browser_snapshot");
  if (!r.isError || !/no tab attached/i.test(r.text)) throw new Error(`unexpected: ${r.text.slice(0, 200)}`);
});

/* ========================================================== 2. real website */

heading("2. Real public websites over the network");

await test("opens example.com and renders its real content", async () => {
  const r = await call("browser_new_tab", { url: "https://example.com" });
  if (!/Example Domain/.test(r.text)) throw new Error(r.text.slice(0, 300));
});

await test("browser_text returns real prose from the live page", async () => {
  const r = await call("browser_text");
  if (!/illustrative examples|documentation examples/i.test(r.text)) throw new Error(r.text.slice(0, 300));
});

await test("clicking a real link performs a real cross-origin navigation", async () => {
  const snap = await call("browser_snapshot");
  const ref = refFor(snap.text, /link .*More information|link .*Learn more/i);
  if (!ref) throw new Error(`no link in snapshot:\n${snap.text.slice(0, 400)}`);
  await call("browser_click", { ref });
  await sleep(2500);
  const url = await evalPage("location.href");
  if (!/iana\.org/i.test(url)) throw new Error(`did not navigate, still at ${url}`);
});

await test("browser_navigate back returns to the previous real page", async () => {
  await call("browser_navigate", { action: "back" });
  await sleep(2000);
  const url = await evalPage("location.href");
  if (!/example\.com/i.test(url)) throw new Error(`back failed, at ${url}`);
});

await test("browser_navigate forward re-applies the navigation", async () => {
  await call("browser_navigate", { action: "forward" });
  await sleep(2500);
  const url = await evalPage("location.href");
  if (!/iana\.org/i.test(url)) throw new Error(`forward failed, at ${url}`);
});

await test("the snapshot returned by a navigating click describes the DESTINATION page", async () => {
  await call("browser_navigate", { action: "goto", url: "https://example.com" });
  await sleep(1200);
  const snap = await call("browser_snapshot");
  const ref = refFor(snap.text, /link .*More information|link .*Learn more/i);
  if (!ref) throw new Error("no link to click");
  const clicked = await call("browser_click", { ref });
  // The tool must block on the new document, not report the page it replaced.
  const reported = clicked.text.match(/^URL: (.+)$/m)?.[1] ?? "";
  if (!/iana\.org/i.test(reported)) throw new Error(`snapshot still on ${reported}`);
});

await test("interaction in a background tab auto-focuses it and really works", async () => {
  const opened = await call("browser_new_tab", { url: "https://example.com", background: true });
  const tabId = Number(opened.text.match(/tab (\d+)/)?.[1]);
  const snap = await call("browser_snapshot");
  const ref = refFor(snap.text, /link .*More information|link .*Learn more/i);
  if (!ref) throw new Error("no link in the background tab");
  const clicked = await call("browser_click", { ref });
  const reported = clicked.text.match(/^URL: (.+)$/m)?.[1] ?? "";
  if (!/iana\.org/i.test(reported)) throw new Error(`background click did not navigate; still ${reported}`);
  const url = await evalPage("location.href");
  if (/example\.com/.test(url)) throw new Error(`page really did not navigate, at ${url}`);
  if (Number.isFinite(tabId)) await call("browser_close_tab", { tabId });
  await call("browser_attach");
});

await test("handles a large real-world SPA-style page (Wikipedia)", async () => {
  await call("browser_navigate", { action: "goto", url: "https://en.wikipedia.org/wiki/Web_browser" });
  await sleep(3000);
  const snap = await call("browser_snapshot");
  if (!/heading/.test(snap.text)) throw new Error("no headings found");
  if (!/\[ref=[a-z0-9]+-e\d+\]/.test(snap.text)) throw new Error("no refs issued");
  const lines = snap.text.split("\n").length;
  if (lines < 40) throw new Error(`snapshot suspiciously small (${lines} lines)`);
});

await test("real page exposes a working search box that accepts typing", async () => {
  const snap = await call("browser_snapshot");
  const ref = refFor(snap.text, /(textbox|searchbox|combobox).*(Search)/i);
  if (!ref) throw new Error(`no search box:\n${snap.text.split("\n").filter((l) => /textbox|searchbox/.test(l)).join("\n").slice(0, 400)}`);
  await call("browser_type", { ref, text: "Hypertext" });
  await sleep(600);
  const value = await evalPage(`document.querySelector('input[name=search]')?.value ?? ''`);
  if (!/Hypertext/i.test(value)) throw new Error(`search box value was ${JSON.stringify(value)}`);
});

await test("full-page screenshot of a real long article exceeds the viewport shot", async () => {
  const viewport = await call("browser_screenshot");
  const full = await call("browser_screenshot", { fullPage: true });
  if (!viewport.image || !full.image) throw new Error("missing image content");
  if (full.image.data.length <= viewport.image.data.length) {
    throw new Error(`full ${full.image.data.length} !> viewport ${viewport.image.data.length}`);
  }
});

await test("redaction applies to a real login form (Wikipedia)", async () => {
  await call("browser_navigate", { action: "goto", url: "https://en.wikipedia.org/wiki/Special:UserLogin" });
  await sleep(2500);
  const planted = await evalPage(`(() => { const el = document.querySelector('#wpPassword1'); if (!el) return false; el.value = 'REALSECRET123'; return true; })()`);
  if (planted !== true) throw new Error("could not find Wikipedia's password field — selector changed, test is not proving anything");
  const after = await call("browser_snapshot");
  if (/REALSECRET123/.test(after.text)) throw new Error("password leaked into snapshot");
  return true;
});

/* ====================================================== 3. deterministic DOM */

heading("3. Interaction against a real locally-served site");

await test("opens the local form page and finds every control", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/form` });
  await sleep(700);
  const snap = await call("browser_snapshot");
  for (const pattern of [/textbox "Query"/, /combobox/, /checkbox/, /button "Submit"/]) {
    if (!pattern.test(snap.text)) throw new Error(`missing ${pattern} in:\n${snap.text.slice(0, 600)}`);
  }
});

await test("typing, selecting, checking and submitting drives real page state", async () => {
  let snap = (await call("browser_snapshot")).text;
  await call("browser_type", { ref: refFor(snap, /textbox "Query"/), text: "real-input" });
  snap = (await call("browser_snapshot")).text;
  await call("browser_select_option", { ref: refFor(snap, /combobox/), values: ["Gamma"] });
  snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /checkbox/) });
  snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /button "Submit"/) });
  await sleep(500);
  const out = await evalPage("document.getElementById('out').textContent");
  if (out !== "sent:real-input|c|true") throw new Error(`page reported ${JSON.stringify(out)}`);
});

await test("isTrusted is true for a bridge-dispatched click", async () => {
  await call("browser_evaluate", { expression: `window.__trusted = null; document.getElementById('agree').addEventListener('click', e => { window.__trusted = e.isTrusted; }, { once: true });` });
  const snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /checkbox/) });
  await sleep(400);
  const trusted = await evalPage("window.__trusted");
  if (trusted !== true) throw new Error(`isTrusted was ${JSON.stringify(trusted)}`);
});

await test("clear replaces existing input instead of appending", async () => {
  await call("browser_evaluate", { expression: `document.getElementById('q').value = 'STALE-VALUE'` });
  const snap = (await call("browser_snapshot")).text;
  await call("browser_type", { ref: refFor(snap, /textbox "Query"/), text: "FRESH", clear: true });
  await sleep(300);
  const value = await evalPage("document.getElementById('q').value");
  if (value !== "FRESH") throw new Error(`value was ${JSON.stringify(value)}`);
});

await test("submit:true presses Enter and fires the real form handler", async () => {
  await call("browser_evaluate", { expression: `document.getElementById('out').textContent = 'idle'` });
  const snap = (await call("browser_snapshot")).text;
  await call("browser_type", { ref: refFor(snap, /textbox "Query"/), text: "via-enter", clear: true, submit: true });
  await sleep(600);
  const out = await evalPage("document.getElementById('out').textContent");
  if (!/^sent:via-enter/.test(out)) throw new Error(`out was ${JSON.stringify(out)}`);
});

await test("secrets in real password/OTP/email fields never enter the snapshot", async () => {
  const snap = (await call("browser_snapshot")).text;
  for (const secret of ["TOPSECRET-pw", "998877", "private@example.com"]) {
    if (snap.includes(secret)) throw new Error(`leaked ${secret}`);
  }
  if (!snap.includes("<redacted>")) throw new Error("no redaction marker present");
});

await test("pointer-events:none overlays are excluded from the snapshot", async () => {
  const snap = (await call("browser_snapshot")).text;
  if (snap.includes("GHOSTOVERLAY")) throw new Error("ghost overlay leaked into snapshot");
});

await test("snapshot leaves the real page DOM completely unmodified", async () => {
  const count = await evalPage("document.querySelectorAll('[data-cbref]').length");
  if (count !== 0) throw new Error(`${count} attributes written into the page`);
});

/* ============================================================== 4. keyboard */

heading("4. Keyboard fidelity");

await test("perKey typing emits one real keydown per character", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/keys` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  await call("browser_type", { ref: refFor(snap, /textbox/), text: "abcde", perKey: true });
  await sleep(500);
  const count = await evalPage("Number(document.getElementById('count').textContent)");
  if (count < 5) throw new Error(`only ${count} keydown events for 5 characters`);
});

await test("named keys carry the correct key and code", async () => {
  await call("browser_press_key", { key: "ArrowLeft" });
  await sleep(300);
  const last = await evalPage("document.getElementById('last').textContent");
  if (last !== "ArrowLeft/ArrowLeft") throw new Error(`got ${JSON.stringify(last)}`);
});

await test("digits map to DigitN codes, not KeyN", async () => {
  await call("browser_press_key", { key: "5" });
  await sleep(300);
  const last = await evalPage("document.getElementById('last').textContent");
  if (last !== "5/Digit5") throw new Error(`got ${JSON.stringify(last)}`);
});

await test("punctuation maps to its real physical code", async () => {
  await call("browser_press_key", { key: "/" });
  await sleep(300);
  const last = await evalPage("document.getElementById('last').textContent");
  if (last !== "//Slash") throw new Error(`got ${JSON.stringify(last)}`);
});

await test("modifier shortcuts arrive as shortcuts, not typed text", async () => {
  const before = await evalPage("document.getElementById('k').value");
  await call("browser_press_key", { key: "k", modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await sleep(300);
  const combo = await evalPage("document.getElementById('combo').textContent");
  const after = await evalPage("document.getElementById('k').value");
  if (combo !== "shortcut") throw new Error(`shortcut not detected (${combo})`);
  if (after !== before) throw new Error(`modifier key typed a character: ${JSON.stringify(after)}`);
});

await test("unicode and emoji survive insertText intact", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/unicode` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  await call("browser_type", { ref: refFor(snap, /textbox/), text: "héllo — 世界 🚀" });
  await sleep(400);
  const value = await evalPage("document.getElementById('u').value");
  if (value !== "héllo — 世界 🚀") throw new Error(`got ${JSON.stringify(value)}`);
});

/* ========================================================= 5. contenteditable */

heading("5. Rich editors and shadow DOM");

await test("clear works on a real contenteditable host", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/editable` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /ORIGINAL CONTENT/);
  if (!ref) throw new Error(`contenteditable not in snapshot:\n${snap.slice(0, 500)}`);
  await call("browser_type", { ref, text: "REPLACED", clear: true });
  await sleep(400);
  const value = await evalPage("document.getElementById('ed').textContent.trim()");
  if (value.includes("ORIGINAL")) throw new Error(`append instead of replace: ${JSON.stringify(value)}`);
  if (!value.includes("REPLACED")) throw new Error(`text not inserted: ${JSON.stringify(value)}`);
});

await test("snapshot descends into a real open shadow root", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/shadow` });
  await sleep(700);
  const snap = (await call("browser_snapshot")).text;
  if (!/Shadow Button/.test(snap.text ?? snap)) throw new Error(`shadow content missing:\n${snap.slice(0, 500)}`);
});

await test("clicking a shadow-DOM button reaches its real handler", async () => {
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /Shadow Button/);
  if (!ref) throw new Error("no ref for shadow button");
  await call("browser_click", { ref });
  await sleep(500);
  const out = await evalPage("document.getElementById('out').textContent");
  if (out !== "shadow-clicked") throw new Error(`handler not fired, out=${JSON.stringify(out)}`);
});

/* ============================================================== 6. occlusion */

heading("6. Occlusion, scrolling and layout");

await test("a button hidden under a sticky banner is reported as covered", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/covered` });
  await sleep(700);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /Buried Button/);
  if (!ref) throw new Error("button not in snapshot");
  const r = await call("browser_click", { ref });
  if (!/Warning: .*overlapped/i.test(r.text)) throw new Error(`no coverage warning:\n${r.text.slice(0, 300)}`);
});

await test("scrolling a real long page reveals off-screen content", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/long` });
  await sleep(600);
  const before = (await call("browser_snapshot")).text;
  if (before.includes("BOTTOMMARKER")) throw new Error("bottom already visible; page too short to test");
  await call("browser_scroll", { deltaY: 4200 });
  await sleep(600);
  const after = (await call("browser_snapshot")).text;
  if (!after.includes("BOTTOMMARKER")) throw new Error("scroll did not reveal the bottom marker");
});

await test("scroll targets the real viewport centre", async () => {
  const centre = await evalPage("JSON.stringify({w: innerWidth, h: innerHeight})");
  const { w, h } = JSON.parse(centre);
  // A hardcoded {400,300} would sit outside a narrow or short viewport.
  await call("browser_evaluate", { expression: "window.scrollTo(0,0); window.__hit=null; document.addEventListener('wheel', e => { window.__hit = [Math.round(e.clientX), Math.round(e.clientY)]; }, { once: true, capture: true }); 1" });
  await call("browser_scroll", { deltaY: 300 });
  const hit = JSON.parse(await evalPage("JSON.stringify(window.__hit)"));
  if (!hit) throw new Error("no wheel event observed");
  // cssVisualViewport excludes the scrollbar, so allow one scrollbar width of slack.
  if (Math.abs(hit[0] - w / 2) > 20 || Math.abs(hit[1] - h / 2) > 20) {
    throw new Error(`wheel dispatched at ${hit}, expected viewport centre ~${[Math.round(w / 2), Math.round(h / 2)]}`);
  }
});

/* ============================================================== 7. dialogs */

heading("7. JavaScript dialogs");

await test("an alert is reported instead of hanging the tool", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/dialogs` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  const started = Date.now();
  const clicked = await call("browser_click", { ref: refFor(snap, /button "Alert"/) });
  const elapsed = Date.now() - started;
  if (elapsed > 20000) throw new Error(`click hung for ${elapsed}ms while a dialog was open`);
  if (!/dialog is open/i.test(clicked.text)) throw new Error(`no dialog report:
${clicked.text.slice(0, 300)}`);
  await call("browser_handle_dialog", { accept: true });
});

await test("a confirm dialog can be accepted and the page continues", async () => {
  const snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /button "Confirm"/) });
  await call("browser_handle_dialog", { accept: true });
  const out = await evalPage("document.getElementById('out').textContent");
  if (out !== "accepted") throw new Error(`confirm result was ${JSON.stringify(out)}`);
});

await test("a confirm dialog can be dismissed", async () => {
  const snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /button "Confirm"/) });
  await call("browser_handle_dialog", { accept: false });
  const out = await evalPage("document.getElementById('out').textContent");
  if (out !== "dismissed") throw new Error(`dismiss result was ${JSON.stringify(out)}`);
});

/* ======================================================= 8. console and cdp */

heading("8. Console capture and raw CDP");

await test("console.log, warn, error and uncaught throws are all captured", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/console` });
  await sleep(1200);
  const logs = (await call("browser_console")).text;
  for (const needle of ["LOGLINE-alpha", "WARNLINE-beta", "ERRORLINE-gamma", "THROWNLINE-delta"]) {
    if (!logs.includes(needle)) throw new Error(`missing ${needle} in:\n${logs.slice(0, 500)}`);
  }
});

await test("raw CDP returns real protocol data", async () => {
  const r = await call("browser_cdp", { method: "Page.getLayoutMetrics" });
  const metrics = JSON.parse(r.text);
  if (!metrics.cssLayoutViewport?.clientWidth) throw new Error(r.text.slice(0, 300));
});

await test("raw CDP reaches domains no tool wraps (Network cookies)", async () => {
  const r = await call("browser_cdp", { method: "Network.getAllCookies" });
  if (!("cookies" in JSON.parse(r.text))) throw new Error(r.text.slice(0, 200));
});

await test("browser_evaluate awaits real promises", async () => {
  const value = await evalPage(`new Promise(r => setTimeout(() => r(6*7), 300))`);
  if (value !== 42) throw new Error(`got ${value}`);
});

/* ======================================================= 9. tabs lifecycle */

heading("9. Tab lifecycle and multi-tab");

let secondTab;
await test("a second tab can be opened and becomes the attached tab", async () => {
  const r = await call("browser_new_tab", { url: `${LOCAL}/form` });
  secondTab = Number(r.text.match(/tab (\d+)/)?.[1]);
  if (!Number.isFinite(secondTab)) throw new Error(r.text.slice(0, 200));
  const url = await evalPage("location.pathname");
  if (url !== "/form") throw new Error(`attached to ${url}`);
});

await test("browser_tabs lists both tabs and marks the attached one", async () => {
  const r = await call("browser_tabs");
  const starred = r.text.split("\n").filter((l) => l.startsWith("*"));
  if (starred.length !== 1) throw new Error(`expected exactly one attached marker:\n${r.text.slice(0, 500)}`);
  if (!starred[0].includes(String(secondTab))) throw new Error(`wrong tab marked:\n${starred[0]}`);
});

await test("attaching to a different tab switches control", async () => {
  // Open a second real page so there is a genuine http(s) tab to switch to.
  const extra = await call("browser_new_tab", { url: `${LOCAL}/keys`, background: true });
  const extraTab = Number(extra.text.match(/tab (\d+)/)?.[1]);
  if (!Number.isFinite(extraTab)) throw new Error(extra.text.slice(0, 200));

  await call("browser_attach", { tabId: secondTab });
  const backOnForm = await evalPage("location.pathname");
  if (backOnForm !== "/form") throw new Error(`expected /form, got ${backOnForm}`);

  await call("browser_attach", { tabId: extraTab });
  const switched = await evalPage("location.pathname");
  if (switched !== "/keys") throw new Error(`switch failed, at ${switched}`);

  await call("browser_close_tab", { tabId: extraTab });
  await call("browser_attach", { tabId: secondTab });
});

await test("re-attaching to the already-attached tab is a safe no-op", async () => {
  await call("browser_attach", { tabId: secondTab });
  await call("browser_attach", { tabId: secondTab });
  const path = await evalPage("location.pathname");
  if (path !== "/form") throw new Error(`lost the session, at ${path}`);
});

await test("a page-opened popup is reported to the agent", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/popup` });
  await sleep(700);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /Open in new tab/);
  if (!ref) throw new Error("no target=_blank link");
  const clicked = await call("browser_click", { ref });
  await sleep(1500);
  const after = await call("browser_snapshot");
  const combined = clicked.text + after.text;
  if (!/new tab \(\d+\) was opened/i.test(combined)) {
    throw new Error(`agent was never told:\n${combined.slice(-400)}`);
  }
  // Clean up the tab the page opened.
  const tabs = await call("browser_tabs");
  const stray = tabs.text.split("\n").find((l) => /example\.com|about:blank/.test(l) && /\[\d+\]/.test(l));
  const strayId = Number(stray?.match(/\[(\d+)\]/)?.[1]);
  if (Number.isFinite(strayId)) await raw("browser_close_tab", { tabId: strayId });
  await call("browser_attach", { tabId: secondTab });
});

await test("browser_new_tab does NOT report itself as a surprise popup", async () => {
  const opened = await call("browser_new_tab", { url: `${LOCAL}/form` });
  if (/was opened/i.test(opened.text)) throw new Error(`self-opened tab reported as a popup:\n${opened.text.slice(-300)}`);
  const id = Number(opened.text.match(/tab (\d+)/)?.[1]);
  if (Number.isFinite(id)) await call("browser_close_tab", { tabId: id });
  // Closing the attached tab clears the attachment; hand control back.
  await call("browser_attach", { tabId: secondTab });
});

await test("closing the attached tab really removes it from the browser", async () => {
  await call("browser_close_tab");
  await sleep(600);
  const r = await call("browser_tabs");
  if (r.text.includes(`[${secondTab}]`)) throw new Error("tab still listed after close");
});

/* ================================================== 10. refs and staleness */

heading("10. Ref lifecycle");

await test("refs are invalidated by navigation rather than silently reused", async () => {
  await call("browser_attach");
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/form` });
  await sleep(700);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /button "Submit"/);
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/keys` });
  await sleep(800);
  const r = await raw("browser_click", { ref });
  if (!r.isError) throw new Error("stale ref was accepted after navigation");
  if (!/unknown ref|fresh browser_snapshot/i.test(r.text)) throw new Error(`unhelpful error: ${r.text.slice(0, 200)}`);
});

await test("a ref from an older snapshot never aliases a different element", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/form` });
  await sleep(600);
  const first = (await call("browser_snapshot")).text;
  const submit = refFor(first, /button "Submit"/);
  // Remove an earlier control so a naive index-based scheme would renumber.
  await call("browser_evaluate", { expression: `document.getElementById('q').remove()` });
  const second = (await call("browser_snapshot")).text;
  const submitAgain = refFor(second, /button "Submit"/);
  if (submit !== submitAgain) throw new Error(`ref for the same element changed: ${submit} -> ${submitAgain}`);
  const stale = refFor(first, /textbox "Query"/);
  const r = await raw("browser_click", { ref: stale });
  if (!r.isError) throw new Error("a ref for a removed element still resolved");
});

await test("a ref pointing at a removed element fails loudly", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/form` });
  await sleep(700);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /button "Submit"/);
  await call("browser_evaluate", { expression: `document.querySelector('#f button[type=submit]').remove()` });
  const r = await raw("browser_click", { ref });
  if (!r.isError || !/removed from the page/i.test(r.text)) throw new Error(`got: ${r.text.slice(0, 200)}`);
});

/* ============================================================ 11. failures */

heading("11. Error handling");

const errorCases = [
  ["rejects an unknown tab id", "browser_attach", { tabId: 99999999 }, /no tab with id/i],
  ["rejects a malformed ref", "browser_click", { ref: "not-a-ref" }, /invalid element ref/i],
  ["rejects click with neither ref nor coordinates", "browser_click", {}, /provide either/i],
  ["rejects goto without a url", "browser_navigate", { action: "goto" }, /url.*required/i],
  ["surfaces page JavaScript exceptions", "browser_evaluate", { expression: "throw new Error('BOOM')" }, /BOOM/],
  ["surfaces JavaScript syntax errors", "browser_evaluate", { expression: "function(" }, /syntax/i],
  ["rejects an unknown CDP method", "browser_cdp", { method: "Bogus.doesNotExist" }, /bogus|not found|wasn't found|invalid/i],
  ["rejects select_option for an unknown ref", "browser_select_option", { ref: "aaaa11-e1", values: ["x"] }, /unknown ref/i],
];

for (const [label, tool, args, pattern] of errorCases) {
  await test(label, async () => {
    const r = await raw(tool, args);
    if (!r.isError) throw new Error(`expected an error, got: ${r.text.slice(0, 200)}`);
    if (!pattern.test(r.text)) throw new Error(`error text did not match ${pattern}: ${r.text.slice(0, 200)}`);
  });
}

await test("a failed tool call never kills the session", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/form` });
  await sleep(600);
  const r = await call("browser_snapshot");
  if (!/button "Submit"/.test(r.text)) throw new Error("session unusable after errors");
});

/* ==================================================== 12. added capabilities */

heading("12. Images, hover, waiting, upload and iframes");

await test("images with alt text appear in the snapshot", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/hover` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  if (!/image "Hover Target"/.test(snap)) throw new Error(`image missing:\n${snap.slice(0, 400)}`);
});

await test("browser_hover reveals hover-only content", async () => {
  const snap = (await call("browser_snapshot")).text;
  if (/REVEALED CAPTION/.test(snap)) throw new Error("caption already visible; page cannot test hover");
  const ref = refFor(snap, /image "Hover Target"/);
  const after = await call("browser_hover", { ref });
  if (!/REVEALED CAPTION/.test(after.text)) throw new Error(`hover did not reveal:\n${after.text.slice(0, 300)}`);
});

await test("browser_wait_for blocks until late content arrives", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/slow` });
  await sleep(500);
  const snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /button "Start"/) });
  const waited = await call("browser_wait_for", { text: "ARRIVED LATE", timeoutMs: 10000 });
  if (!/ARRIVED LATE/.test(waited.text)) throw new Error(waited.text.slice(0, 300));
});

await test("browser_wait_for reports a real timeout rather than hanging", async () => {
  const r = await raw("browser_wait_for", { text: "NEVER-APPEARS-XYZ", timeoutMs: 1500 });
  if (!r.isError || !/timed out/i.test(r.text)) throw new Error(r.text.slice(0, 200));
});

await test("browser_upload attaches a real file to a file input", async () => {
  const probe = "/tmp/cb-e2e-upload.txt";
  fs.writeFileSync(probe, "chrome-bridge e2e upload");
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/upload` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /file-input/);
  if (!ref) throw new Error(`no file input:\n${snap.slice(0, 300)}`);
  await call("browser_upload", { ref, files: [probe] });
  const names = await evalPage("document.getElementById('names').textContent");
  if (!/cb-e2e-upload\.txt/.test(names)) throw new Error(`change event reported ${JSON.stringify(names)}`);
  fs.unlinkSync(probe);
});

await test("browser_upload rejects a missing or relative path", async () => {
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /file-input/);
  const missing = await raw("browser_upload", { ref, files: ["/tmp/definitely-not-here-xyz.txt"] });
  if (!missing.isError || !/no such file/i.test(missing.text)) throw new Error(missing.text.slice(0, 200));
  const relative = await raw("browser_upload", { ref, files: ["relative.txt"] });
  if (!relative.isError || !/absolute/i.test(relative.text)) throw new Error(relative.text.slice(0, 200));
});

await test("iframe content is included in the snapshot", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/parent` });
  await sleep(900);
  const snap = (await call("browser_snapshot")).text;
  if (!/^- iframe /m.test(snap)) throw new Error(`no iframe block:\n${snap.slice(0, 400)}`);
  if (!/Child Button/.test(snap)) throw new Error("child content missing from snapshot");
});

await test("iframe elements get their own ref namespace", async () => {
  const snap = (await call("browser_snapshot")).text;
  const child = refFor(snap, /Child Button/);
  const parent = refFor(snap, /Parent Button/);
  if (!child || !parent) throw new Error("missing refs");
  if (child.split("-")[0] === parent.split("-")[0]) throw new Error("frames share an epoch");
});

await test("clicking inside an iframe hits the frame, not the parent", async () => {
  const snap = (await call("browser_snapshot")).text;
  await call("browser_click", { ref: refFor(snap, /Child Button/) });
  const inner = await evalPage("document.getElementById('f').contentDocument.getElementById('o').textContent");
  const outer = await evalPage("document.getElementById('po').textContent");
  if (inner !== "CHILD-CLICKED") throw new Error(`iframe handler not fired: ${JSON.stringify(inner)}`);
  if (outer !== "parent-idle") throw new Error(`parent was hit instead: ${JSON.stringify(outer)}`);
});

await test("typing into an iframe field works", async () => {
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /child field/);
  if (!ref) throw new Error("child field not in snapshot");
  await call("browser_type", { ref, text: "typed-in-frame" });
  const value = await evalPage("document.getElementById('f').contentDocument.getElementById('i').value");
  if (value !== "typed-in-frame") throw new Error(`got ${JSON.stringify(value)}`);
});

await test("a hidden file input is still reachable for upload", async () => {
  const probe = "/tmp/cb-e2e-hidden.txt";
  fs.writeFileSync(probe, "hidden upload probe");
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/hiddenupload` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  const ref = refFor(snap, /file-input/);
  if (!ref) throw new Error(`display:none file input missing from snapshot:\n${snap.slice(0, 400)}`);
  await call("browser_upload", { ref, files: [probe] });
  const names = await evalPage("document.getElementById('names').textContent");
  if (!/cb-e2e-hidden\.txt/.test(names)) throw new Error(`got ${JSON.stringify(names)}`);
  fs.unlinkSync(probe);
});

await test("an SPA route change is reported to the agent", async () => {
  await call("browser_navigate", { action: "goto", url: `${LOCAL}/spa` });
  await sleep(600);
  const snap = (await call("browser_snapshot")).text;
  const clicked = await call("browser_click", { ref: refFor(snap, /button "Open detail"/) });
  if (!/DETAIL VIEW/.test(clicked.text)) throw new Error(`snapshot missed the new view:\n${clicked.text.slice(0, 300)}`);
  const combined = clicked.text + (await call("browser_snapshot")).text;
  if (!/without a reload|no longer valid/i.test(combined)) {
    throw new Error(`agent never told the route changed:\n${combined.slice(-300)}`);
  }
});

/* ============================================================= 14. teardown */

heading("13. Detach and cleanup");

await test("favicon badge is applied while attached", async () => {
  const badged = await evalPage(`(document.querySelector('link[rel~="icon"]')?.href ?? '').startsWith('data:image/svg+xml')`);
  if (badged !== true) throw new Error("no favicon badge while attached");
});

await test("detach releases the tab and restores page state", async () => {
  await call("browser_detach");
  const r = await raw("browser_snapshot");
  if (!r.isError || !/no tab attached/i.test(r.text)) throw new Error(`still attached: ${r.text.slice(0, 200)}`);
});

await test("the bridge survives detach and can attach again", async () => {
  await call("browser_attach");
  const r = await call("browser_snapshot");
  if (!/URL:/.test(r.text)) throw new Error("could not resume after detach");
  await call("browser_detach");
});

/* =============================================================== summary */

server.close();
await client.close();

const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${"─".repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed  (${seconds}s)\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m [${f.section}] ${f.label}\n      ${String(f.detail).slice(0, 300)}`);
} else {
  console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed\x1b[0m  (${seconds}s)`);
}
process.exit(failures.length ? 1 : 0);
