/**
 * Unit tests for the report-text helpers (saarathi#46).
 *
 * Consumers find the page address with the first line matching /^URL:/m.
 * JavaScript's multiline `^` also matches after \r, U+2028 and U+2029, so
 * these tests count URL: lines with that same regex, not by splitting on \n.
 */
import { fenceUrlLines, oneLine } from "../dist/report-text.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

const BREAKS = /[\r\n\u2028\u2029]/;
const urlLines = (s) => [...s.matchAll(/^URL:\s*(\S+)/gm)];

// Seeded generator (mulberry32) so a failure reproduces.
let seed = 46;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const PIECES = [
  "\n", "\r", "\r\n", "\u2028", "\u2029", "URL:", "URL: https://attacker.example/", " ", "  ", "\t",
  "Title: x", '- button "Pay" [ref=e1]', "a", "é", "url:",
];
const randomText = () => {
  let s = "";
  const n = Math.floor(rand() * 20);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)];
  return s;
};

check("oneLine flattens each break kind", oneLine("a\nb\rc\r\nd\u2028e\u2029f") === "a b c d e f");
check("oneLine leaves ordinary text alone", oneLine("Hostile — page") === "Hostile — page");

let firstBad;
for (let i = 0; i < 2000 && !firstBad; i++) {
  const s = randomText();
  if (BREAKS.test(oneLine(s))) firstBad = s;
}
check("oneLine output never contains a line break (2000 generated)", !firstBad, firstBad && JSON.stringify(firstBad));

const real = "URL: https://bank.example/login\nTitle: Bank";
check("fenceUrlLines keeps line 1", fenceUrlLines(real) === real);
check(
  "fenceUrlLines indents a later URL: line",
  fenceUrlLines(`${real}\nURL: https://attacker.example/`) === `${real}\n  URL: https://attacker.example/`,
);
check(
  "fenceUrlLines keeps an indented ref line intact",
  fenceUrlLines(`${real}\n  - link "x" [ref=e2]`) === `${real}\n  - link "x" [ref=e2]`,
);

check(
  "fenceUrlLines(text, 0) also indents line 1",
  fenceUrlLines("URL: https://attacker.example/\nok", 0) === "  URL: https://attacker.example/\nok",
);

firstBad = undefined;
for (let i = 0; i < 2000 && !firstBad; i++) {
  const body = randomText();
  if (urlLines(fenceUrlLines(body, 0)).length) firstBad = body;
}
check("fenceUrlLines(text, 0) leaves no URL: line (2000 generated)", !firstBad, firstBad && JSON.stringify(firstBad));

firstBad = undefined;
for (let i = 0; i < 2000 && !firstBad; i++) {
  const body = randomText();
  const out = fenceUrlLines(`URL: https://bank.example/\n${body}`);
  const found = urlLines(out);
  if (found.length !== 1 || found[0].index !== 0 || found[0][1] !== "https://bank.example/") firstBad = body;
}
check("fenceUrlLines leaves exactly one URL: line, at line 1 (2000 generated)", !firstBad, firstBad && JSON.stringify(firstBad));

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall report-text checks passed");
