import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(packageRoot, "dist", "index.js");
const extensionDir = path.join(packageRoot, "extension");
const skillSource = path.join(packageRoot, "skills", "control-chrome-bridge");
const skillName = path.basename(skillSource);

const SERVER_NAME = "chrome-bridge";
type Scope = "global" | "project";

interface Client {
  id: string;
  label: string;
  /** Where server entries live inside the config file. */
  key: string;
  format: "json" | "toml";
  global: string;
  /** Relative to the project directory. Absent when the client has no project-level config. */
  project?: string;
}

const CLIENTS: Client[] = [
  { id: "claude-code", label: "Claude Code", key: "mcpServers", format: "json", global: path.join(HOME, ".claude.json"), project: ".mcp.json" },
  { id: "codex", label: "Codex CLI", key: "mcp_servers", format: "toml", global: path.join(HOME, ".codex", "config.toml") },
  { id: "cursor", label: "Cursor", key: "mcpServers", format: "json", global: path.join(HOME, ".cursor", "mcp.json"), project: path.join(".cursor", "mcp.json") },
  { id: "vscode", label: "VS Code", key: "servers", format: "json", global: path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"), project: path.join(".vscode", "mcp.json") },
  { id: "windsurf", label: "Windsurf", key: "mcpServers", format: "json", global: path.join(HOME, ".codeium", "windsurf", "mcp_config.json") },
  { id: "claude-desktop", label: "Claude Desktop", key: "mcpServers", format: "json", global: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json") },
  { id: "copilot-cli", label: "GitHub Copilot CLI", key: "mcpServers", format: "json", global: path.join(HOME, ".copilot", "mcp-config.json") },
  { id: "gemini", label: "Gemini CLI", key: "mcpServers", format: "json", global: path.join(HOME, ".gemini", "settings.json"), project: path.join(".gemini", "settings.json") },
];

/** Skill directories, by scope. Only those whose parent already exists are used for `global`. */
const SKILL_ROOTS: Record<Scope, string[]> = {
  global: [path.join(HOME, ".codex", "skills"), path.join(HOME, ".claude", "skills")],
  project: [path.join(".codex", "skills"), path.join(".claude", "skills")],
};

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const tilde = (p: string) => (p.startsWith(HOME) ? p.replace(HOME, "~") : p);

function configPath(client: Client, scope: Scope, projectDir: string): string | undefined {
  if (scope === "global") return client.global;
  return client.project ? path.join(projectDir, client.project) : undefined;
}

function backup(file: string) {
  const copy = `${file}.chrome-bridge-backup`;
  if (!fs.existsSync(copy)) fs.copyFileSync(file, copy);
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

const entryFor = () => ({ command: process.execPath, args: [serverEntry] });

type Result = { status: "added" | "updated" | "failed"; detail?: string };

function installJson(file: string, key: string): Result {
  let config: any = {};
  if (fs.existsSync(file)) {
    try {
      config = parseLooseJson(fs.readFileSync(file, "utf8"));
    } catch (error) {
      return { status: "failed", detail: `unparseable (${(error as Error).message}) — add the entry by hand` };
    }
    backup(file);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const bucket = (config[key] ??= {});
  const existed = Object.prototype.hasOwnProperty.call(bucket, SERVER_NAME);
  bucket[SERVER_NAME] = entryFor();
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { status: existed ? "updated" : "added" };
}

function installToml(file: string, key: string): Result {
  const header = `[${key}.${SERVER_NAME}]`;
  const block = [header, `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(serverEntry)}]`].join("\n");

  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${block}\n`, "utf8");
    return { status: "added" };
  }

  const raw = fs.readFileSync(file, "utf8");
  backup(file);

  if (raw.includes(header)) {
    // Replace only this table, stopping at the next top-level table header.
    const pattern = new RegExp(`\\n?${header.replace(/[[\]().]/g, "\\$&")}[\\s\\S]*?(?=\\n\\[|$)`);
    fs.writeFileSync(file, raw.replace(pattern, `\n${block}\n`), "utf8");
    return { status: "updated" };
  }

  fs.writeFileSync(file, `${raw}${raw.endsWith("\n") ? "\n" : "\n\n"}${block}\n`, "utf8");
  return { status: "added" };
}

function installSkill(scope: Scope, projectDir: string): string[] {
  if (!fs.existsSync(skillSource)) return [];
  const installed: string[] = [];

  for (const root of SKILL_ROOTS[scope]) {
    const absolute = scope === "global" ? root : path.join(projectDir, root);
    // Globally, only populate skill directories the user already uses; in a
    // project, create them, since that is an explicit opt-in for this repo.
    if (scope === "global" && !fs.existsSync(absolute)) continue;

    const destination = path.join(absolute, skillName);
    fs.mkdirSync(destination, { recursive: true });
    for (const file of fs.readdirSync(skillSource)) {
      fs.copyFileSync(path.join(skillSource, file), path.join(destination, file));
    }
    installed.push(destination);
  }
  return installed;
}

async function prompt(rl: readline.Interface, question: string, fallback: string): Promise<string> {
  const answer = (await rl.question(question)).trim();
  return answer === "" ? fallback : answer;
}

/** Parses "1,3", "1 3", "all" or "none" against a numbered list. */
function parseSelection<T>(answer: string, items: T[]): T[] {
  const normalised = answer.toLowerCase();
  if (normalised === "a" || normalised === "all") return [...items];
  if (normalised === "n" || normalised === "none") return [];
  const picked = new Set<T>();
  for (const token of normalised.split(/[\s,]+/).filter(Boolean)) {
    const index = Number(token);
    if (Number.isInteger(index) && index >= 1 && index <= items.length) picked.add(items[index - 1]);
  }
  return [...picked];
}

export async function runSetup(argv: string[]) {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);

  const dryRun = flag("dry-run");
  const assumeYes = flag("yes") || flag("y");
  const requested = value("client");
  const projectDir = path.resolve(value("project-dir") ?? process.cwd());

  let scope: Scope | undefined = flag("project") ? "project" : flag("global") ? "global" : undefined;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !assumeYes && !requested;

  console.log(`\n${bold("chrome-bridge-mcp setup")}\n`);

  if (!fs.existsSync(serverEntry)) {
    console.error(`${yellow("!")} ${tilde(serverEntry)} is missing. Run ${bold("npm run build")} first.\n`);
    process.exit(1);
  }

  let chosen: Client[] = [];

  if (requested) {
    const match = CLIENTS.find((c) => c.id === requested);
    if (!match) {
      console.error(`${yellow("!")} Unknown client "${requested}". Known: ${CLIENTS.map((c) => c.id).join(", ")}\n`);
      process.exit(1);
    }
    chosen = [match];
  }

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      // ---- which agents -----------------------------------------------------
      const detected = CLIENTS.filter((c) => fs.existsSync(c.global));
      const ordered = [...detected, ...CLIENTS.filter((c) => !detected.includes(c))];

      console.log(`${bold("Which coding agents should get chrome-bridge?")}\n`);
      ordered.forEach((client, index) => {
        const found = detected.includes(client) ? green("detected") : dim("not detected");
        console.log(`  ${cyan(String(index + 1).padStart(2))}. ${client.label.padEnd(20)} ${found}`);
      });
      console.log(`\n  ${dim("Enter numbers (e.g. 1,3), 'all', or press Enter for all detected.")}`);

      const answer = await prompt(rl, `\n  ${bold(">")} `, "detected");
      chosen = answer === "detected" ? detected : parseSelection(answer, ordered);

      if (!chosen.length) {
        console.log(`\n${yellow("!")} Nothing selected — no changes made.\n`);
        return;
      }

      // ---- which scope ------------------------------------------------------
      const projectCapable = chosen.filter((c) => c.project);
      if (projectCapable.length) {
        console.log(`\n${bold("Install globally, or for this project only?")}\n`);
        console.log(`  ${cyan(" 1")}. Global ${dim("— available in every project")}`);
        console.log(`  ${cyan(" 2")}. This project only ${dim(`— ${tilde(projectDir)}`)}`);
        if (projectCapable.length < chosen.length) {
          const globalOnly = chosen.filter((c) => !c.project);
          const names = globalOnly.map((c) => c.label).join(", ");
          const verb = globalOnly.length === 1 ? "has" : "have";
          console.log(`\n  ${dim(`${names} ${verb} no project-level config, so ${globalOnly.length === 1 ? "it" : "they"} will be installed globally.`)}`);
        }
        const scopeAnswer = await prompt(rl, `\n  ${bold(">")} `, "1");
        scope = scopeAnswer.startsWith("2") ? "project" : "global";
      } else {
        scope = "global";
      }
    } finally {
      rl.close();
    }
  }

  scope ??= "global";
  if (!chosen.length) chosen = CLIENTS.filter((c) => fs.existsSync(c.global));

  if (!chosen.length) {
    console.log(`${yellow("!")} No MCP client config files found.\n`);
    console.log(`  Pick one explicitly, e.g. ${bold("--client cursor")}, or add this to your client's config:\n`);
    console.log(dim(`  ${JSON.stringify({ mcpServers: { [SERVER_NAME]: entryFor() } }, null, 2)}\n`));
    return;
  }

  // Clients with no project config still have to go somewhere sensible.
  const plan = chosen.map((client) => {
    const effective: Scope = scope === "project" && !client.project ? "global" : (scope as Scope);
    return { client, scope: effective, file: configPath(client, effective, projectDir)! };
  });

  let step = 1;
  console.log(`\n${bold(`${step++}.`)} ${dryRun ? "Would register" : "Registering"} the MCP server ${dim(`(${scope})`)}\n`);

  for (const { client, scope: effective, file } of plan) {
    const suffix = effective !== scope ? dim(" (global — no project config)") : "";
    if (dryRun) {
      console.log(`  ${dim("→")} ${client.label.padEnd(20)} ${dim(tilde(file))}${suffix}`);
      continue;
    }
    try {
      const result = client.format === "toml" ? installToml(file, client.key) : installJson(file, client.key);
      const mark = result.status === "failed" ? yellow("!") : green("✓");
      console.log(`  ${mark} ${client.label.padEnd(20)} ${dim(result.detail ?? tilde(file))}${suffix}`);
    } catch (error) {
      console.log(`  ${yellow("!")} ${client.label.padEnd(20)} ${dim(String((error as Error).message))}`);
    }
  }

  if (!dryRun) {
    console.log(dim(`\n  Existing files were backed up alongside as *.chrome-bridge-backup.`));
    console.log(dim(`  Comments in JSON configs are not preserved — the backup keeps your original.`));
  }

  const skills = dryRun ? [] : installSkill(scope, projectDir);
  if (skills.length) {
    console.log(`\n${bold(`${step++}.`)} Installing the agent skill\n`);
    for (const dir of skills) console.log(`  ${green("✓")} ${dim(tilde(dir))}`);
  }

  console.log(`\n${bold(`${step}.`)} Load the Chrome extension ${dim("(the one manual step — browsers block automated installs)")}\n`);
  console.log(`  1. Open ${bold("chrome://extensions")}`);
  console.log(`  2. Turn on ${bold("Developer mode")} (top right)`);
  console.log(`  3. Click ${bold("Load unpacked")} and select:\n`);
  console.log(`     ${green(extensionDir)}\n`);
  console.log(`  The toolbar icon shows a green dot once it connects.\n`);
  console.log(dim(`  Restart your coding agent so it picks up the new server.\n`));
}

export { extensionDir, serverEntry, SERVER_NAME, entryFor };
