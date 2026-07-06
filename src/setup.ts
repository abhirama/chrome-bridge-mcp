import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(packageRoot, "dist", "index.js");
const extensionDir = path.join(packageRoot, "extension");
const skillSource = path.join(packageRoot, "skills", "control-chrome-bridge");

const SERVER_NAME = "chrome-bridge";

interface Target {
  id: string;
  label: string;
  file: string;
  /** Where server entries live inside the file. */
  key: string;
  format: "json" | "toml";
  /** Zed and friends use a different entry shape. */
  shape?: "standard" | "zed";
}

const TARGETS: Target[] = [
  { id: "claude-code", label: "Claude Code", file: path.join(HOME, ".claude.json"), key: "mcpServers", format: "json" },
  { id: "codex", label: "Codex CLI", file: path.join(HOME, ".codex", "config.toml"), key: "mcp_servers", format: "toml" },
  { id: "cursor", label: "Cursor", file: path.join(HOME, ".cursor", "mcp.json"), key: "mcpServers", format: "json" },
  { id: "windsurf", label: "Windsurf", file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", format: "json" },
  { id: "claude-desktop", label: "Claude Desktop", file: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"), key: "mcpServers", format: "json" },
  { id: "vscode", label: "VS Code", file: path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"), key: "servers", format: "json" },
  { id: "copilot-cli", label: "GitHub Copilot CLI", file: path.join(HOME, ".copilot", "mcp-config.json"), key: "mcpServers", format: "json" },
  { id: "gemini", label: "Gemini CLI", file: path.join(HOME, ".gemini", "settings.json"), key: "mcpServers", format: "json" },
];

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function backup(file: string) {
  const copy = `${file}.chrome-bridge-backup`;
  if (!fs.existsSync(copy)) fs.copyFileSync(file, copy);
  return copy;
}

/** JSON with comments and trailing commas is common in editor configs. */
function parseLooseJson(text: string): any {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  }
}

function entryFor(): Record<string, unknown> {
  return { command: process.execPath, args: [serverEntry] };
}

function installJson(target: Target): { status: "added" | "updated" | "skipped"; detail?: string } {
  const existed = fs.existsSync(target.file);
  let config: any = {};

  if (existed) {
    const raw = fs.readFileSync(target.file, "utf8");
    try {
      config = parseLooseJson(raw);
    } catch (error) {
      return { status: "skipped", detail: `could not parse (${(error as Error).message}) — add the entry by hand` };
    }
    backup(target.file);
  } else {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
  }

  const bucket = (config[target.key] ??= {});
  const already = Object.prototype.hasOwnProperty.call(bucket, SERVER_NAME);
  bucket[SERVER_NAME] = entryFor();

  fs.writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { status: already ? "updated" : "added" };
}

function installToml(target: Target): { status: "added" | "updated" | "skipped"; detail?: string } {
  const header = `[${target.key}.${SERVER_NAME}]`;
  const block = [
    header,
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(serverEntry)}]`,
  ].join("\n");

  if (!fs.existsSync(target.file)) {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, `${block}\n`, "utf8");
    return { status: "added" };
  }

  const raw = fs.readFileSync(target.file, "utf8");
  backup(target.file);

  if (raw.includes(header)) {
    // Replace just this table, up to the next top-level table header.
    const pattern = new RegExp(`\\n?${header.replace(/[[\]().]/g, "\\$&")}[\\s\\S]*?(?=\\n\\[|$)`);
    fs.writeFileSync(target.file, raw.replace(pattern, `\n${block}\n`), "utf8");
    return { status: "updated" };
  }

  const separator = raw.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(target.file, `${raw}${separator}${block}\n`, "utf8");
  return { status: "added" };
}

/** Copies the agent skill into the well-known skill directories that exist. */
function installSkill(): string[] {
  if (!fs.existsSync(skillSource)) return [];
  const installed: string[] = [];
  for (const root of [path.join(HOME, ".codex", "skills"), path.join(HOME, ".claude", "skills")]) {
    if (!fs.existsSync(root)) continue;
    const destination = path.join(root, path.basename(skillSource));
    fs.mkdirSync(destination, { recursive: true });
    for (const file of fs.readdirSync(skillSource)) {
      fs.copyFileSync(path.join(skillSource, file), path.join(destination, file));
    }
    installed.push(destination);
  }
  return installed;
}

export function runSetup(argv: string[]) {
  const only = argv.includes("--client") ? argv[argv.indexOf("--client") + 1] : undefined;
  const dryRun = argv.includes("--dry-run");

  console.log(`\n${bold("chrome-bridge-mcp setup")}\n`);

  if (!fs.existsSync(serverEntry)) {
    console.error(`${yellow("!")} ${serverEntry} is missing. Run ${bold("npm run build")} first.\n`);
    process.exit(1);
  }

  const candidates = TARGETS.filter((t) => (only ? t.id === only : fs.existsSync(t.file)));

  if (only && !candidates.length) {
    console.error(`${yellow("!")} Unknown client "${only}". Known: ${TARGETS.map((t) => t.id).join(", ")}\n`);
    process.exit(1);
  }

  if (!candidates.length) {
    console.log(`${yellow("!")} No MCP client config files found.\n`);
    console.log(`  Pick one explicitly, e.g. ${bold("--client cursor")}, or add this to your client's config:\n`);
    console.log(dim(`  ${JSON.stringify({ mcpServers: { [SERVER_NAME]: entryFor() } }, null, 2)}\n`));
    return;
  }

  console.log(`${bold("1.")} Registering the MCP server\n`);
  for (const target of candidates) {
    if (dryRun) {
      console.log(`  ${dim("would update")} ${target.label} ${dim(target.file)}`);
      continue;
    }
    try {
      const result = target.format === "toml" ? installToml(target) : installJson(target);
      const mark = result.status === "skipped" ? yellow("!") : green("✓");
      console.log(`  ${mark} ${target.label} ${dim(result.detail ?? target.file)}`);
    } catch (error) {
      console.log(`  ${yellow("!")} ${target.label} ${dim(String((error as Error).message))}`);
    }
  }

  if (!dryRun && candidates.length) {
    console.log(dim(`\n  Each edited file was backed up alongside it as *.chrome-bridge-backup.`));
    console.log(dim(`  Comments in JSON configs are not preserved — the backup has the original.`));
  }

  if (!dryRun) {
    const skills = installSkill();
    if (skills.length) {
      console.log(`\n${bold("2.")} Installing the agent skill\n`);
      for (const dir of skills) console.log(`  ${green("✓")} ${dim(dir)}`);
    }
  }

  console.log(`\n${bold(skillsHeading(dryRun))} Loading the Chrome extension ${dim("(one manual step — browsers block automated installs)")}\n`);
  console.log(`  1. Open ${bold("chrome://extensions")}`);
  console.log(`  2. Turn on ${bold("Developer mode")} (top right)`);
  console.log(`  3. Click ${bold("Load unpacked")} and select:\n`);
  console.log(`     ${green(extensionDir)}\n`);
  console.log(`  The toolbar icon shows a green dot once it connects.\n`);
  console.log(dim(`  Restart your MCP client so it picks up the new server.\n`));
}

function skillsHeading(dryRun: boolean) {
  return dryRun ? "2." : "3.";
}

export { extensionDir, serverEntry, SERVER_NAME, entryFor };
