/**
 * Determines empirically whether two independent extensions can both drive the
 * same tab via chrome.debugger — i.e. whether chrome-bridge-mcp can coexist
 * with Codex/ChatGPT or Claude in Chrome on one page.
 *
 * Extension A is ours (port 8787); extension B is a byte-identical copy with a
 * different id, standing in for the other vendor's extension (port 8788).
 *
 * Requires Chrome launched with both extensions loaded.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>Shared</title><h1>Shared</h1><button id='b' onclick=\"document.title='clicked'\">Press</button>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

async function connect(label, port) {
  const client = new Client({ name: label, version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist", "index.js"), "--port", String(port)],
      stderr: "inherit",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: !!result.isError, body: result.content.map((p) => (p.type === "text" ? p.text : "<image>")).join("\n") };
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await call("browser_tabs")).isError) return { client, call };
    if (attempt === 29) throw new Error(`${label}: extension never connected on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const a = await connect("ours", Number(process.argv[2] ?? 8787));
const b = await connect("rival", Number(process.argv[3] ?? 8788));

const opened = await a.call("browser_new_tab", { url });
check("A opened and attached to a tab", !opened.isError, opened.body.slice(0, 120));
const tabId = Number(opened.body.match(/tab (\d+)/)?.[1]);

// The question the user actually cares about.
const rivalAttach = await b.call("browser_attach", { tabId });
console.log(`\n>>> Second extension attaching to the same tab: ${rivalAttach.isError ? "REFUSED" : "ALLOWED"}`);
console.log(`>>> ${rivalAttach.body.split("\n")[0]}\n`);

if (rivalAttach.isError) {
  check("refusal names the cause", /another debugger/i.test(rivalAttach.body), rivalAttach.body.slice(0, 200));
  const stillOurs = await a.call("browser_snapshot");
  check("A keeps working after B is refused", !stillOurs.isError, stillOurs.body.slice(0, 120));

  const otherTab = await b.call("browser_new_tab", { url });
  check("B can drive a different tab concurrently", !otherTab.isError, otherTab.body.slice(0, 120));
  const bothLive = await a.call("browser_snapshot");
  check("A still works while B drives its own tab", !bothLive.isError, bothLive.body.slice(0, 120));
  await b.call("browser_close_tab");
} else {
  check("both extensions report the same page", /Shared/.test(rivalAttach.body), rivalAttach.body.slice(0, 160));
  const aStill = await a.call("browser_snapshot");
  check("A still works while B is also attached", !aStill.isError, aStill.body.slice(0, 160));
  const bClick = await b.call("browser_evaluate", { expression: "document.title" });
  check("B can evaluate on the shared tab", !bClick.isError, bClick.body.slice(0, 120));
  await b.call("browser_detach");
  const aAfter = await a.call("browser_snapshot");
  check("A survives B detaching", !aAfter.isError, aAfter.body.slice(0, 160));
}

const listed = await a.call("browser_tabs");
console.log(`\nbrowser_tabs from A:\n${listed.body.slice(0, 500)}`);

await a.call("browser_close_tab");
await a.call("browser_detach");
await b.call("browser_detach");
await a.client.close();
await b.client.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nCoexistence behaviour confirmed.");
process.exit(failures ? 1 : 0);
