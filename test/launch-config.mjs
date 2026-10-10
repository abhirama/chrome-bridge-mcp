/**
 * Launcher-supplied settings (extension/launch-config.js) and the manifest
 * guarantees that keep the token in launch.json private.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLaunchConfig, resolveSettings, readLaunchText } from "../extension/launch-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n--- launch.json parsing ---");
check("valid config parses", same(parseLaunchConfig('{"port":8787,"token":"t0k"}'), { port: 8787, token: "t0k" }));
check("extra fields are dropped", same(parseLaunchConfig('{"port":1,"token":"x","enabled":false}'), { port: 1, token: "x" }));
for (const [label, text] of [
  ["not JSON", "{port:"],
  ["null", "null"],
  ["array", "[8787]"],
  ["port 0", '{"port":0,"token":"x"}'],
  ["port 65536", '{"port":65536,"token":"x"}'],
  ["fractional port", '{"port":87.5,"token":"x"}'],
  ["string port", '{"port":"8787","token":"x"}'],
  ["missing token", '{"port":8787}'],
  ["empty token", '{"port":8787,"token":""}'],
  ["numeric token", '{"port":8787,"token":5}'],
]) {
  check(`rejects ${label}`, parseLaunchConfig(text) === null);
}

console.log("\n--- fallback to stored settings ---");
const stored = { port: 8787, token: "stored", enabled: false };
check("no launch.json keeps storage", same(resolveSettings(stored, null), stored));
check("malformed launch.json keeps storage", same(resolveSettings(stored, "nope"), stored));
check(
  "valid launch.json overrides port and token, keeps enabled",
  same(resolveSettings(stored, '{"port":9000,"token":"launch"}'), { port: 9000, token: "launch", enabled: false }),
);

console.log("\n--- reading launch.json ---");
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => (url === "ext://launch.json" ? new Response('{"port":1,"token":"a"}') : new Response("", { status: 404 }));
check("reads the file via the extension URL", (await readLaunchText((p) => `ext://${p}`)) === '{"port":1,"token":"a"}');
check("404 reads as absent", (await readLaunchText((p) => `ext://missing/${p}`)) === null);
globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
check("fetch failure reads as absent", (await readLaunchText((p) => p)) === null);
globalThis.fetch = realFetch;

console.log("\n--- manifest ---");
const manifest = JSON.parse(readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const exposed = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
check(
  "launch.json is not web-accessible",
  !exposed.some((resource) => resource === "*" || resource.includes("*") || resource.endsWith("launch.json")),
  JSON.stringify(exposed),
);
check("manifest pins the extension ID with a key", typeof manifest.key === "string" && manifest.key.length > 300);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall launch-config checks passed");
