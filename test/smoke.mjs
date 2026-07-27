/**
 * End-to-end smoke test: serves a local page, spawns the MCP server over stdio,
 * waits for the Chrome extension to connect, then exercises every tool.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PORT = process.argv[2];
const serverArgs = [path.join(root, "dist", "index.js"), ...(BRIDGE_PORT ? ["--port", BRIDGE_PORT] : [])];
const PAGE = `<!doctype html><html><head><title>Bridge Test</title></head><body>
<h1>Bridge Test</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted:'+q.value+'/'+pick.value;">
  <label for="q">Search</label><input id="q" name="q" placeholder="Type here">
  <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <button type="submit">Go</button>
</form>
<input id="pw" type="password" value="hunter2-secret">
<input id="otp" name="one-time-code" value="123456">
<div id="ghost" style="pointer-events:none;position:fixed;inset:0">ghost overlay text</div>
<p id="out">nothing yet</p>
<button id="log" onclick="console.log('hello from page')">Log</button>
<div style="height:2000px"></div><p id="bottom">bottom marker</p>
<script>console.log("page loaded")</script>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    stderr: "inherit",
  }),
);

let failures = 0;
const call = async (name, args = {}, { expectError = false } = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const body = result.content
    .map((part) => (part.type === "text" ? part.text : `<image ${part.mimeType}, ${part.data.length} b64 chars>`))
    .join("\n");
  const bad = !!result.isError !== expectError;
  if (bad) failures++;
  console.log(`\n=== ${bad ? "FAIL " : "ok   "} ${name}(${JSON.stringify(args)})\n${body.slice(0, 900)}`);
  return body;
};

const check = (label, condition) => {
  if (!condition) failures++;
  console.log(`${condition ? "ok   " : "FAIL "} assert: ${label}`);
};

const { tools } = await client.listTools();
console.log(`Tools exposed (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

for (let attempt = 0; attempt < 25; attempt++) {
  const result = await client.callTool({ name: "browser_tabs", arguments: {} });
  if (!result.isError) break;
  if (attempt === 24) throw new Error("Chrome extension never connected.");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

await call("browser_tabs");
await call("browser_new_tab", { url });

const snap = await call("browser_snapshot");
const refOf = (pattern) => snap.match(pattern)?.[1];
const textbox = refOf(/textbox "Search".*\[ref=([a-z0-9]+-e\d+)\]/);
const combo = refOf(/combobox.*\[ref=([a-z0-9]+-e\d+)\]/);
const goButton = refOf(/button "Go".*\[ref=([a-z0-9]+-e\d+)\]/);
const logButton = refOf(/button "Log".*\[ref=([a-z0-9]+-e\d+)\]/);
check("snapshot found the textbox", !!textbox);
check("snapshot found the select", !!combo);
check("snapshot found the submit button", !!goButton);

await call("browser_type", { ref: textbox, text: "hello world" });
check("typed value is in the page", (await call("browser_evaluate", { expression: "q.value" })).includes("hello world"));

await call("browser_select_option", { ref: combo, values: ["Beta"] });
check("select changed", (await call("browser_evaluate", { expression: "pick.value" })).includes("b"));

await call("browser_click", { ref: goButton });
const out = await call("browser_evaluate", { expression: "out.textContent" });
check("form submitted via trusted click", out.includes("submitted:hello world/b"));

await call("browser_click", { ref: logButton });
check("console captured page log", (await call("browser_console")).includes("hello from page"));

await call("browser_scroll", { deltaY: 1800 });
check("scrolled to bottom marker", (await call("browser_snapshot")).includes("bottom marker"));

await call("browser_press_key", { key: "Home" });
await call("browser_text", { maxChars: 300 });
await call("browser_screenshot");
await call("browser_navigate", { action: "reload" });
check("state reset after reload", (await call("browser_evaluate", { expression: "out.textContent" })).includes("nothing yet"));

const post = await call("browser_snapshot");
check("password value is redacted", post.includes("<redacted>") && !post.includes("hunter2-secret"));
check("one-time-code value is redacted", !post.includes("123456"));
check("pointer-events:none overlay is excluded", !post.includes("ghost overlay text"));

const dom = await call("browser_evaluate", { expression: "document.querySelectorAll('[data-cbref]').length" });
check("snapshot leaves no attributes in the page DOM", dom.trim() === "0");

const icon = await call("browser_evaluate", { expression: "document.querySelector('link[rel~=\\'icon\\']')?.href.startsWith('data:image/svg+xml') ?? false" });
check("favicon badge applied while attached", icon.includes("true"));

await call("browser_cdp", { method: "Page.getLayoutMetrics" });
await call("browser_click", { ref: "zzzz99-e9999" }, { expectError: true });
await call("browser_close_tab");
await call("browser_detach");

server.close();
await client.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
