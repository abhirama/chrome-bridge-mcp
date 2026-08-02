<p align="center">
  <img src="assets/banner.png" alt="chrome-bridge-mcp" width="100%">
</p>

<p align="center">
  <b>An MCP server that drives your already-running, already-logged-in Chrome.</b><br>
  Real profile. Real cookies. Real sessions. From any MCP-capable coding tool.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-21-10A37F?style=flat-square" alt="21 tools">
  <img src="https://img.shields.io/badge/tests-75%20real--world-0EA5A4?style=flat-square" alt="75 real-world tests">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-1B2735?style=flat-square" alt="Node 20+">
  <img src="https://img.shields.io/badge/licence-MIT-1B2735?style=flat-square" alt="MIT">
</p>

---

## Quick start

```bash
git clone https://github.com/ShalomObongo/chrome-bridge-mcp.git
cd chrome-bridge-mcp
npm install && npm run build && npm run setup
```

`npm run setup` is interactive. It detects the MCP clients on your machine — Claude Code, Codex,
Cursor, Windsurf, Claude Desktop, VS Code, Copilot CLI, Gemini — then asks two questions:

```
Which coding agents should get chrome-bridge?

   1. Claude Code          detected
   2. Cursor               detected
   3. Codex CLI            not detected
   ...

  Enter numbers (e.g. 1,3), 'all', or press Enter for all detected.
  > 1,2

Install globally, or for this project only?

   1. Global — available in every project
   2. This project only — ~/Developer/my-app
  > 1
```

It then writes the config, installs the agent skill, and prints the one manual step: loading the
Chrome extension.

Then, in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder this repo printed
4. Restart your coding tool

The extension's toolbar icon shows a green dot once it connects. That's it — ask your agent to
*"open my LinkedIn feed and tell me what's there"* and it will drive your real browser.

> Chrome 137+ ignores the `--load-extension` command-line flag, so "Load unpacked" is the supported
> path. It is the only step that cannot be automated: browsers deliberately block programmatic
> extension installs.

## Why not Playwright?

Playwright and Puppeteer launch their own browser, or need Chrome restarted with
`--remote-debugging-port`. Either way you get a blank profile and none of the user's logins.

The trick both Codex and this project use is the **`chrome.debugger` extension API**: an extension
can obtain full Chrome DevTools Protocol access to a tab in the *running* browser with no launch
flags, no restart, and no separate profile. Input is dispatched through CDP's `Input` domain, so
pages receive genuine trusted events rather than synthetic ones that bot detection rejects.

## Architecture

```
┌────────────────┐  stdio/MCP  ┌──────────────────┐   ws://127.0.0.1:8787   ┌─────────────────┐
│  Coding tool   │◄───────────►│ chrome-bridge-mcp│◄───────────────────────►│ Chrome extension│
│ (Claude Code,  │   JSON-RPC  │   (this package) │   JSON commands          │  MV3 service    │
│  Copilot CLI,  │             │   MCP + WS hub   │                          │  worker         │
│  Cursor, Zed…) │             └──────────────────┘                          └────────┬────────┘
└────────────────┘                      ▲                                             │
                                        │ hub relay                     chrome.debugger│ (CDP)
                              ┌─────────┴─────────┐                                    ▼
                              │ 2nd tool's server │                          ┌──────────────────┐
                              │  (guest role)     │                          │ Your real tab,   │
                              └───────────────────┘                          │ logged in        │
                                                                             └──────────────────┘
```

The **first** server process to start binds the port and becomes the hub host; it owns the single
extension socket. Later processes detect the bound port and attach as guests, tunnelling their
commands through the host. Several coding tools can therefore share one browser connection instead
of fighting over the port.

Each process carries its own client id, and the extension keys tab attachments by it. Two tools can
work on **different tabs at the same time** without retargeting each other, or deliberately share one
tab — and one detaching never tears down the other's session.

Host and guests exchange a protocol version on connect. After upgrading, a long-running process from
the previous install may still hold the port; rather than silently dropping unknown envelope fields
(which is precisely how per-client isolation once regressed), a guest refuses such a host and tells
you to restart it or pass `--port`. **After upgrading, stop any existing `chrome-bridge-mcp` process
and reload the extension.**

The extension is deliberately thin — it only knows how to attach, list tabs and relay raw CDP.
Every higher-level tool (snapshot, click, type, scroll) is implemented server-side on top of CDP,
so the tool surface can evolve without reinstalling the extension.

## Install

### The short way

```bash
npm run setup                    # interactive: pick agents, pick scope
npm run setup -- --dry-run       # show what it would change, then exit
```

Setup backs up every file it edits alongside the original as `*.chrome-bridge-backup`, and is safe
to re-run — existing entries are updated in place, never duplicated. Note that JSON configs are
rewritten without comments; the backup keeps your original. Clients you do not select are never
touched.

**Global vs project.** Global installs into your home config so the browser is available in every
project. Project installs into the current directory instead — `.mcp.json` for Claude Code,
`.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, plus `.claude/skills/` and
`.codex/skills/` for the skill. Codex CLI, Windsurf, Claude Desktop and Copilot CLI have no
project-level MCP config, so those always install globally and setup tells you so.

**Skip the prompts** for scripting or CI:

```bash
npm run setup -- --yes                        # every detected client, global
npm run setup -- --client cursor --project    # one client, this directory
npm run setup -- --client codex --global
```

| Flag | Meaning |
| --- | --- |
| `--client <id>` | `claude-code`, `codex`, `cursor`, `vscode`, `windsurf`, `claude-desktop`, `copilot-cli`, `gemini` |
| `--global` | Install for every project (default) |
| `--project` | Install for the current directory only |
| `--project-dir <path>` | Use this directory instead of the working directory |
| `--yes` | Non-interactive: every detected client, global scope |
| `--dry-run` | Print the plan and exit without writing |

Setup falls back to non-interactive automatically when stdin is not a TTY, so piping into it is safe.

### The manual way

If you would rather edit config yourself, the entry is the same everywhere — an absolute path to
`dist/index.js`:

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add chrome-bridge -- node /absolute/path/to/chrome-bridge-mcp/dist/index.js
```
</details>

<details>
<summary><b>Codex CLI</b> (<code>~/.codex/config.toml</code>)</summary>

```toml
[mcp_servers.chrome-bridge]
command = "node"
args = ["/absolute/path/to/chrome-bridge-mcp/dist/index.js"]
```
</details>

<details>
<summary><b>GitHub Copilot CLI</b></summary>

```bash
copilot mcp add --name chrome-bridge --command node --args /absolute/path/to/chrome-bridge-mcp/dist/index.js
```
</details>

<details>
<summary><b>Cursor · Windsurf · Claude Desktop · Gemini CLI</b></summary>

In `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`,
`~/Library/Application Support/Claude/claude_desktop_config.json` or `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-bridge-mcp/dist/index.js"]
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b> (<code>~/Library/Application Support/Code/User/mcp.json</code>)</summary>

VS Code uses `servers` rather than `mcpServers`:

```json
{
  "servers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-bridge-mcp/dist/index.js"]
    }
  }
}
```
</details>

### The agent skill

`skills/control-chrome-bridge/SKILL.md` teaches an agent how to drive the browser well: the core
loop, ref discipline, when *not* to reach for a browser, and the safety rules that matter when the
sessions are real. Setup installs it for you — into `~/.codex/skills/` and `~/.claude/skills/` for a
global install (only where those directories already exist), or into `.codex/skills/` and
`.claude/skills/` in the project for a project install. Other clients can point at the file
directly.

### Options

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--port <n>` | `CHROME_BRIDGE_PORT` | `8787` | WebSocket bridge port |
| `--token <s>` | `CHROME_BRIDGE_TOKEN` | *(none)* | Shared secret; set the same value in the extension popup |
| `--extension-id <id>` | `CHROME_BRIDGE_EXTENSION_ID` | *(any)* | Pin the bridge to a single extension id |
| `--no-page-badge` | — | — | Leave the page favicon untouched while attached |
| `--hub-only` | — | — | Run just the bridge, no MCP stdio server |

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| *"Chrome extension is not connected"* | Chrome must be running with the extension enabled. Click its toolbar icon and check the dot is green. |
| Tools missing from your client | Restart the client — MCP servers are read at startup. |
| *"incompatible (older) chrome-bridge-mcp"* | A process from a previous install still holds the port. Stop it, or run with `--port <other>`. |
| Extension shows no dot | The server has not started. Your MCP client launches it on demand; run `npm run hub` to start it standalone. |
| Upgraded the repo | Stop any running server **and** reload the extension at `chrome://extensions`. |

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_tabs` | List every open tab across all windows |
| `browser_attach` | Take control of an existing tab (this is what reuses the user's logins) |
| `browser_new_tab` | Open and attach to a new tab |
| `browser_navigate` | `goto` / `back` / `forward` / `reload` |
| `browser_snapshot` | Ref-annotated outline of everything visible — the primary "what's on screen" tool |
| `browser_text` | Readable page text |
| `browser_screenshot` | PNG of the viewport or full page |
| `browser_click` | Click by snapshot `ref`, or raw viewport `x`/`y` |
| `browser_hover` | Hover without clicking — for menus and tooltips that only appear on hover |
| `browser_type` | Focus a field and type, with optional `clear` and `submit` |
| `browser_press_key` | Single key with modifiers |
| `browser_scroll` | Scroll page or element |
| `browser_select_option` | Choose `<select>` options |
| `browser_handle_dialog` | Accept or dismiss a blocking alert / confirm / prompt |
| `browser_upload` | Attach local files to a file input |
| `browser_wait_for` | Block until text appears/disappears or a JS expression is truthy |
| `browser_evaluate` | Run a JS expression and get the value back |
| `browser_console` | Console messages and uncaught errors |
| `browser_cdp` | Raw CDP escape hatch |
| `browser_close_tab` / `browser_detach` | Clean up |

Snapshots include **iframe content**, nested under an `- iframe "<url>"` line with its own ref
namespace, and clicks and typing inside frames are translated into the right coordinate space.
Images that carry an accessible name are listed too.

Interaction tools return a fresh snapshot, so the model sees the consequence of each action without
a second round-trip. Snapshot refs (`k3f9a1-e12`) carry a per-document epoch and are handed out from
an in-page `Map` — **nothing is written into the page DOM**, and a ref from before a navigation fails
loudly instead of silently resolving to a different element.

Values of password, OTP, email, phone and payment-shaped fields are reported as `<redacted>` rather
than echoed into the transcript.

## Visual feedback

While a tab is attached you get three signals, in decreasing order of usefulness:

| Signal | Where | Meaning |
| --- | --- | --- |
| **Favicon badge** | tab strip | Green dot over a dimmed favicon — visible even when the tab is in the background |
| **Toolbar badge** | extension icon | `▶` amber while acting, `●` green when connected and idle, blank when disconnected |
| **Tab group** | tab strip | Agent-opened tabs are grouped and labelled "MCP agent" |

Plus Chrome's own "… is debugging this browser" banner, which is deliberately not suppressed.

`browser_detach` restores the original favicon and ungroups the tab. Pass `--no-page-badge` to leave
the page's favicon untouched.

**There is deliberately no animated cursor.** Codex ships an elaborate one — spring physics, bezier
approach arcs, squash-and-stretch, an idle "thinking" wobble — and it blocks every click on the
cursor's arrival, up to 1.5 s. Codex gates it on the tab being active and the window unminimised,
precisely because it is only worth paying for when a human is watching. For a terminal-driven MCP
server the human is watching the CLI, so that spend buys nothing. The static indicators above cover
the case that actually matters: a user who stepped away and wants to know what their browser did.

## Coexisting with the Codex / ChatGPT extension

**You can run this alongside OpenAI's Codex extension — including on the same tab.** Verified with
`npm run test:coexist`, which loads two independent extensions and has both attach to one page:
both stay fully functional, and either can detach without disturbing the other. Chrome multiplexes
CDP sessions per target, so `chrome.debugger` is not exclusive.

`browser_tabs` marks tabs that another debugger is also attached to with `+`. That is informational,
not a warning — you can still attach.

**What you cannot do is reuse the Codex extension as this server's transport.** That is a deliberate
design decision on OpenAI's side, and the manifests make it explicit:

- `~/.../Extensions/hehggadaopoacecdllhhajmbjkdcmajg/*/manifest.json` declares **no
  `externally_connectable`**, and `background.js` registers **no `onMessageExternal` or
  `onConnectExternal` listener**. Nothing outside the extension can send it a message — not a web
  page, not another extension, not a local process.
- Its only outbound channel is `chrome.runtime.connectNative("com.openai.codexextension")`, and that
  host's manifest pins `"allowed_origins": ["chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/"]`.
- The Rust host additionally version-negotiates (`nativeHostProtocolVersion`,
  `requiredAppServerProtocolVersion`) and checks a `trustedBrowserClientSha256s` allowlist against
  the JS bundle it loads.

The only interception point is repointing `com.openai.codexextension.json` at a shim — which means
impersonating a signed native host, reimplementing an undocumented versioned protocol, breaking the
user's actual Codex install, and re-breaking on every Codex update. Not worth it, and not something
this project does. Running both extensions side by side gets you the same outcome with none of that.

## Testing

With Chrome running and the extension connected:

```bash
npm run build
npm run test:all            # everything below
npm test                    # security + smoke + multi-client
npm run test:e2e            # 75 real-world checks (see below)
npm run test:coexist        # two extensions sharing one tab (needs both loaded)
```

Every suite drives a real Chrome through the real extension over real CDP — nothing is stubbed.
`test/e2e.mjs` covers all 17 tools across 12 areas:

| Area | Examples |
| --- | --- |
| Real public websites | example.com, Wikipedia and iana.org over the network; cross-origin link clicks; back/forward |
| Interaction | typing, selecting, checkboxes, real form submission, `isTrusted` verification |
| Keyboard fidelity | per-key events, `DigitN`/`Slash` codes, modifier shortcuts not typed as text, unicode and emoji |
| Rich editors | contenteditable replace-not-append, open shadow DOM traversal and clicking |
| Occlusion & layout | sticky-banner coverage warnings, scrolling to reveal off-screen content |
| Dialogs | alert detection, confirm accepted through raw CDP |
| Console & CDP | `log`/`warn`/`error`/uncaught throws, `Network.getAllCookies`, awaited promises |
| Tabs | multi-tab switching, re-attach no-op, real tab closure |
| Ref lifecycle | staleness after navigation, per-snapshot generations, removed elements |
| Errors | 9 negative paths, each asserting the message is actionable |
| Privacy | password/OTP/email redaction on a real Wikipedia login form |
| Images, hover, waiting | alt-text images in snapshots, hover-only menus, `wait_for` with real timeouts |
| Uploads | real file attached to a file input, absolute-path and missing-file rejection |
| Iframes | frame content in snapshots, separate ref namespace, clicking and typing inside frames |
| Dialogs | a blocking alert is reported rather than hanging the tool; accept and dismiss both verified |
| Teardown | favicon badge, detach, resume |

Notable behaviours the suite pins down: a click that navigates returns a snapshot of the
**destination** page (navigation is detected from CDP frame lifecycle events, not by polling), and
interacting with a background tab **auto-focuses it first** — Chrome does not deliver synthesised
input to an inactive tab, so without this the click silently does nothing.

> **Running the suite against a dedicated Chrome.** Chrome heavily throttles timers and rendering in
> occluded windows, which makes long automation runs flaky. Launch the test browser with
> `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
> --disable-background-timer-throttling` and the suite is deterministic even when the window is
> behind your terminal. The same throttling affects normal use: if a tab is in a fully hidden window,
> expect it to be slower. `chrome-bridge` already activates the tab before dispatching input.

`test/smoke.mjs` asserts real behaviour: typing lands in the field, a click actually submits the
form (proving trusted-event dispatch), console capture works, scrolling reveals off-screen content,
secrets are redacted, and the page DOM is left unmodified.

## Security model

This tool has the same reach as the person sitting at the keyboard: any site they are signed into.

- **Origin policy.** Browsers always set `Origin` on WebSocket handshakes and cannot forge it, while
  WebSocket is exempt from CORS. The bridge therefore requires a `chrome-extension://` origin on
  `/extension` and *no* origin on `/client`, and rejects at the HTTP upgrade. Without this, any page
  the user visits could open `ws://127.0.0.1:8787` and drive their browser. Pin a single extension
  with `--extension-id`, and add `--token` for defence in depth against local processes.
- **Ref validation.** Refs are shape-checked (`/^[a-z0-9]{4,10}-e\d+$/`) before they are interpolated
  into any injected script, and are resolved through a `Map` lookup rather than a CSS selector. Refs
  reach the server via the model, which reads untrusted page content, so this is a real boundary.
- The bridge binds `127.0.0.1` only.
- Chrome shows a persistent **"… is debugging this browser"** banner the whole time a tab is
  attached. Do not suppress it — it is the user's signal that automation is live.
- Treat all page content as untrusted data, never as instructions. Confirm before any action with an
  external side effect: sending messages, submitting forms, purchases, permission changes, uploads,
  deletions.

---

## How Codex does it

Reverse-engineered from the plugin bundle shipped with the ChatGPT/Codex desktop app on macOS
(`~/.codex/plugins/cache/openai-bundled/chrome/latest/`). The desktop plugin is proprietary and
closed-source; the public `openai/codex` repo contains no browser tool implementation.

### The pieces

| Component | Location |
| --- | --- |
| Chrome extension | Web Store ID `hehggadaopoacecdllhhajmbjkdcmajg` ("Codex"/"ChatGPT for Chrome") |
| Native messaging manifest | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json` |
| Native host binary (Rust) | `…/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome` |
| Client runtime (1 MB JS bundle) | `…/chrome/latest/scripts/browser-client.mjs` |
| Runtime registry | `~/.codex/chrome-native-hosts-v2.json` |
| Model-facing instructions | `…/chrome/latest/.codex-plugin/unified-skill.md` |
| API reference | `…/chrome/latest/docs/api.json` (22 interfaces, 58 types) |

### The chain

```
model → node_repl "js" MCP tool → browser-client.mjs
      → unix socket /tmp/codex-browser-use/<uuid>.sock   (\\.\pipe\codex-browser-use on Windows)
      → extension-host (Rust native messaging host)
      → Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
      → extension → chrome.debugger → CDP → the page
```

The native host also runs a **local WebSocket server on `127.0.0.1`** ("Codex app-server proxy",
`proxyHost`/`proxyPort` in the registry, HTTP/1.1 → `101 Switching Protocols`) that brokers between
the extension and the `codex app-server` process. It enforces version negotiation
(`nativeHostProtocolVersion`, `appServerProtocolVersion`), an origin allowlist, and a
`trustedBrowserClientSha256s` hash allowlist on the JS bundle.

### The surprising part: it is not a set of MCP tools

Codex exposes **one** tool — a generic JavaScript REPL (`mcp__node_repl__js`). The skill file tells
the model to bootstrap the runtime:

```js
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
  await setupBrowserRuntime({ globals: globalThis });
}
```

and then to write ordinary JavaScript against a rich object graph:

```js
const browser = await agent.browsers.getForUrl("https://example.com/");
const tab = await browser.tabs.new();
await tab.goto("https://example.com/");
await tab.playwright.getByRole("button", { name: "Sign in" }).click();
const shot = await tab.screenshot({});
```

`api.json` documents the full surface: `agent.browsers`, `browser.tabs`, `browser.user`
(`openTabs()`, `claimTab()`, `history()`), and per-tab facades `tab.playwright` (Playwright-style
locators), `tab.cua` (coordinate-based vision control), `tab.dom_cua` (node-id control),
`tab.content`, `tab.clipboard`, `tab.dev.logs`, plus opt-in capabilities discovered at runtime
(`cdp`, `pageAssets`, `browserAuth`, `viewport`, `visibility`, `botDetection`).

On the wire this becomes a flat command vocabulary — `cua_click`, `dom_cua_get_visible_dom`,
`playwright_locator_fill`, `tab_screenshot`, `tab_cdp_call`, `browser_user_claim_tab`, and so on.
Mouse and keyboard commands map onto CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`
(`mousePressed`, `mouseReleased`, `mouseMoved`, `keyUp`), which is why Codex produces trusted input.

### The visual layer

The Codex extension injects a **closed shadow root** into `document.documentElement` (not `body`)
under the id `codex-agent-overlay-root`, styled `pointer-events:none; position:fixed; inset:0;
z-index:2147483646`, and reinstalls it via a `MutationObserver` if the page removes it. Inside it
renders an animated agent cursor (`images/cursor-chat.png`, a 46×48 arrow, declared in
`web_accessible_resources` for `<all_urls>`) driven by eight SwiftUI-style springs on
`requestAnimationFrame`: bezier approach arcs scored from 20 candidates, squash-and-stretch on short
moves, a `#339cff` glow, and an idle wobble after arrival. Every click, scroll and drag awaits the
cursor's arrival, capped at 1500 ms — but only when `chrome.tabs.get(...).active` and the window is
a normal, unminimised one. Otherwise the cursor teleports and nothing blocks.

`browser-client.mjs` knows the overlay id for exactly one reason: it passes it into the DOM-snapshot
script as `codexOverlayRootId`, where the walker skips that subtree entirely. Its visibility test
also rejects `pointerEvents === "none"`, so the overlay is excluded twice over.

Two things are easy to misread in the bundle. First, `browser-client.mjs` vendors Playwright's
injected script, including the glass-pane highlight system (`x-pw-highlight`, `x-pw-action-point`,
`@keyframes pw-fade-out`, `setScreencastAnnotation`). **None of it is reachable** — those symbols
appear only at their own definitions, with no callers; they ride along with Playwright's selector
engine. Codex draws no click ripple and no element outline. Second, the extension's toolbar badge
(`"NEW"`, `#0169cc`) is a one-shot onboarding callout, not an activity indicator.

Codex also badges the page favicon (compositing a data-URI SVG over a dimmed copy of the original:
green `#22c55e` for deliverable, yellow `#facc15` for handoff) and puts agent tabs in a coloured tab
group titled "ChatGPT". It makes no attempt to suppress Chrome's debugging banner.

### What this project reproduces, and what it changes

| Aspect | Codex | chrome-bridge-mcp |
| --- | --- | --- |
| Page control | `chrome.debugger` → CDP | same |
| Trusted input | CDP `Input` domain | same |
| Reuses logged-in profile | yes | yes |
| Extension ↔ host transport | native messaging + unix socket + local WS proxy | single local WebSocket |
| Install friction | signed native host, per-browser manifests, registry entries | load unpacked extension |
| Model interface | one JS REPL tool + injected API + skill file | 21 declarative MCP tools |
| Multi-client | one desktop app | hub/guest, many tools share one browser |
| Element refs | in-memory `WeakMap`, DOM untouched | in-page `Map` + epoch, DOM untouched |
| Secret redaction | field-name heuristics | same heuristics |
| Favicon badge / tab group | yes | yes |
| Animated agent cursor | yes (gated on a human watching) | no — deliberate, see above |
| Portability | ChatGPT desktop only | any MCP client |

Native messaging was dropped deliberately. Codex needs it because the desktop app must launch and
supervise a signed host binary; a WebSocket on loopback gives the same reach with a fraction of the
install surface, and is what Playwright MCP's extension mode uses too.

Declarative tools were chosen over the REPL approach because the REPL only works when the client
already ships a persistent JavaScript sandbox with unix-socket access — which no third-party MCP
client does. Twenty-one well-described tools travel anywhere.

## Licence

MIT. Not affiliated with OpenAI. No OpenAI code, binaries or assets are redistributed; the
architecture notes above describe observable behaviour and file layout only.
