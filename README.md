# chrome-bridge-mcp

An MCP server that drives your **already-running, already-logged-in Chrome** — real profile, real
cookies, real sessions — from any MCP-capable coding tool.

Playwright and Puppeteer launch their own browser, or need Chrome restarted with
`--remote-debugging-port`; either way you get a blank profile and none of your logins. This uses the
`chrome.debugger` extension API instead, which gives full Chrome DevTools Protocol access to a tab
in the *running* browser with no launch flags and no separate profile.

Status: early. See `src/` for the server and `extension/` for the companion Chrome extension.

## Licence

MIT. Not affiliated with OpenAI.
