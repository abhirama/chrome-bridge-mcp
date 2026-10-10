/**
 * Security regression tests.
 *
 * 1. A web page must not be able to reach the bridge. Browsers always set
 *    `Origin` on WebSocket handshakes and WebSocket is exempt from CORS, so the
 *    Origin policy is the only thing standing between a visited page and full
 *    CDP control of the user's browser.
 * 2. A ref must never be able to smuggle JavaScript into an injected script.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Resolves to "open" or "rejected:<code>". */
function probe(pathname, headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}`, { headers });
    const done = (outcome) => {
      socket.removeAllListeners();
      try { socket.close(); } catch {}
      resolve(outcome);
    };
    socket.on("open", () => done("open"));
    socket.on("close", (code) => done(`rejected:${code}`));
    socket.on("error", () => done("rejected:error"));
    setTimeout(() => done("timeout"), 4000);
  });
}

const client = new Client({ name: "security-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js"), "--port", String(PORT)],
    stderr: "inherit",
  }),
);
await new Promise((resolve) => setTimeout(resolve, 1200));

console.log("\n--- Origin policy ---");

check(
  "web page origin cannot open /client",
  (await probe("/client", { Origin: "https://evil.example" })).startsWith("rejected"),
);
check(
  "web page origin cannot impersonate /extension",
  (await probe("/extension", { Origin: "https://evil.example" })).startsWith("rejected"),
);
check(
  "http localhost origin cannot open /client",
  (await probe("/client", { Origin: "http://127.0.0.1:3000" })).startsWith("rejected"),
);
check("local MCP process (no Origin) may open /client", (await probe("/client", {})) === "open");
check(
  "extension origin may open /extension",
  (await probe("/extension", { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })) === "open",
);

console.log("\n--- ref injection ---");

// Vectors the audit proved against the previous querySelector-based resolver.
const VECTORS = [
  `a'+(globalThis.__PWNED_A=1,'')+'`,
  `a", x:(globalThis.__PWNED_B=1), y:"`,
  `e1"]);globalThis.__PWNED_C=1;//`,
  `../../etc/passwd`,
  `e1`, // right shape for the old scheme, wrong shape for the new one
];

for (const ref of VECTORS) {
  const result = await client.callTool({ name: "browser_click", arguments: { ref } });
  const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  check(
    `rejects ref ${JSON.stringify(ref.slice(0, 28))}`,
    !!result.isError && /Invalid element ref/.test(body),
    result.isError ? "" : body.slice(0, 80),
  );
}

const selectResult = await client.callTool({
  name: "browser_select_option",
  arguments: { ref: `a'+(globalThis.__PWNED_D=1,'')+'`, values: ["x"] },
});
check("browser_select_option validates refs too", !!selectResult.isError);

console.log("\n--- protocol handshake ---");
// A host from an older install must be refused rather than silently dropping
// new envelope fields, which is how per-client tab isolation once regressed.
const hello = await new Promise((resolve) => {
  const probe = new WebSocket(`ws://127.0.0.1:${PORT}/client?cid=probe`);
  const done = (v) => { probe.removeAllListeners(); try { probe.close(); } catch {} resolve(v); };
  probe.on("message", (d) => { try { done(JSON.parse(d.toString())); } catch { done(null); } });
  probe.on("error", () => done(null));
  setTimeout(() => done(null), 3000);
});
check("host greets guests with its protocol version", hello?.kind === "hello" && Number.isInteger(hello.protocol), JSON.stringify(hello));

console.log("\n--- session survives the rejected calls ---");
// No extension connects to this isolated port, so the meaningful assertion is
// that the server answers cleanly rather than crashing or hanging.
const tabs = await client.callTool({ name: "browser_tabs", arguments: {} });
const body = tabs.content.map((p) => (p.type === "text" ? p.text : "")).join("");
check("server still answers MCP calls after every rejection", /extension is not connected/i.test(body), body.slice(0, 140));
const tools = await client.listTools();
check("tool list is still served", tools.tools.length === 23, `got ${tools.tools.length}`);
check("owned-window tools are advertised", tools.tools.some((tool) => tool.name === "browser_new_window") && tools.tools.some((tool) => tool.name === "browser_close_window"));

await client.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll security checks passed.");
process.exit(failures ? 1 : 0);
