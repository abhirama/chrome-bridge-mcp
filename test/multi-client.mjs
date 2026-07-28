/**
 * Verifies that two independent MCP server processes — as two coding tools
 * would spawn them — share one browser connection while keeping their own tab
 * attachments, so neither can silently retarget the other's page.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PORT = process.argv[2];
const serverArgs = [path.join(root, "dist", "index.js"), ...(BRIDGE_PORT ? ["--port", BRIDGE_PORT] : [])];

const PAGES = {
  "/alpha": "<!doctype html><title>Alpha</title><h1>ALPHA PAGE</h1>",
  "/beta": "<!doctype html><title>Beta</title><h1>BETA PAGE</h1>",
};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[new URL(req.url, "http://x").pathname] ?? "<!doctype html><title>Other</title>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const LOCAL = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (label, condition, detail = "") => {
  if (!condition) failures++;
  console.log(`${condition ? "ok   " : "FAIL "} ${label}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
};

async function spawnClient(label) {
  const client = new Client({ name: label, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs, stderr: "inherit" }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: !!result.isError, text: result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") };
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await call("browser_tabs")).isError) return { client, call };
    if (attempt === 29) throw new Error(`${label} never connected`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const a = await spawnClient("tool-a");
// Let the first process bind the port so the second attaches as a guest.
await new Promise((r) => setTimeout(r, 1500));
const b = await spawnClient("tool-b");

ok("both processes reach the same browser", !(await a.call("browser_tabs")).isError && !(await b.call("browser_tabs")).isError);

// Each client opens and drives its own page.
const aTab = await a.call("browser_new_tab", { url: `${LOCAL}/alpha` });
const bTab = await b.call("browser_new_tab", { url: `${LOCAL}/beta` });
ok("client A opened its page", /ALPHA PAGE/.test(aTab.text), aTab.text);
ok("client B opened its page", /BETA PAGE/.test(bTab.text), bTab.text);

// The critical property: B's attach must not retarget A.
const aUrl = await a.call("browser_evaluate", { expression: "location.pathname" });
const bUrl = await b.call("browser_evaluate", { expression: "location.pathname" });
ok("client A still sees its own page", /alpha/.test(aUrl.text), aUrl.text);
ok("client B still sees its own page", /beta/.test(bUrl.text), bUrl.text);

const aSnap = await a.call("browser_snapshot");
ok("client A's snapshot is its own page", /ALPHA PAGE/.test(aSnap.text) && !/BETA PAGE/.test(aSnap.text), aSnap.text.slice(0, 160));

// Sharing one tab deliberately must still work.
const aTabId = Number((await a.call("browser_tabs")).text.split("\n").find((l) => l.startsWith("*"))?.match(/\[(\d+)\]/)?.[1]);
if (Number.isFinite(aTabId)) {
  const joined = await b.call("browser_attach", { tabId: aTabId });
  ok("client B can deliberately join client A's tab", /ALPHA PAGE/.test(joined.text), joined.text.slice(0, 160));
  const aStill = await a.call("browser_snapshot");
  ok("client A keeps working while sharing a tab", /ALPHA PAGE/.test(aStill.text), aStill.text.slice(0, 160));
  // B detaching must not tear down A's session.
  await b.call("browser_detach");
  const aAfter = await a.call("browser_snapshot");
  ok("client A survives client B detaching from the shared tab", /ALPHA PAGE/.test(aAfter.text), aAfter.text.slice(0, 160));
} else {
  ok("found client A's tab id", false);
}

await a.call("browser_close_tab");
await a.call("browser_detach");
await a.client.close();
await b.client.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nMulti-client isolation works.");
process.exit(failures ? 1 : 0);
