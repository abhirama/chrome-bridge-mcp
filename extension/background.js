/**
 * Chrome Bridge for MCP — background service worker.
 *
 * Holds a WebSocket to the local chrome-bridge-mcp process and executes the
 * commands it sends. All page control goes through `chrome.debugger`, which
 * gives full Chrome DevTools Protocol access to the user's already-running,
 * already-logged-in profile without any `--remote-debugging-port` flag.
 *
 * MV3 service workers are evicted when idle, so every piece of state that must
 * outlive an eviction lives in `chrome.storage.session` and is rehydrated (and
 * reconciled against the real debugger attachments) on each start.
 */

const DEFAULT_PORT = 8787;
const PROTOCOL_VERSION = "1.3";
const MAX_LOGS = 300;
const RECONNECT_MS = 2000;
const PING_MS = 20_000;
const BUSY_LINGER_MS = 1200;

const BADGES = {
  busy: ["▶", "#F59E0B"],
  on: ["●", "#10A37F"],
  off: ["", "#9E9E9E"],
};

let socket = null;
/** clientId -> tabId. Each MCP process owns its own attachment. */
let attachments = new Map();
/** clientId -> Set<windowId>; only the client that created a window may close it. */
let ownedWindows = new Map();
/** tabId -> { logs, mainFrameId, nav, dialog } */
let tabState = new Map();
let agentGroupId = null;
let reconnectTimer = null;
let pingTimer = null;
let busyTimer = null;
let creatingOwnTab = false;
let ready = null;

/* ------------------------------------------------------------------- state */

async function settings() {
  return chrome.storage.local.get({ port: DEFAULT_PORT, token: "", enabled: true });
}

function stateFor(tabId) {
  let state = tabState.get(tabId);
  if (!state) {
    state = { logs: [], mainFrameId: null, nav: { startedAt: 0, pending: false }, dialog: null };
    tabState.set(tabId, state);
  }
  return state;
}

function ownedTabs() {
  return new Set(attachments.values());
}

async function persist() {
  await chrome.storage.session.set({
    attachments: [...attachments],
    ownedWindows: [...ownedWindows].map(([clientId, ids]) => [clientId, [...ids]]),
    agentGroupId,
    tabState: [...tabState].map(([id, v]) => [id, { ...v, logs: v.logs.slice(-MAX_LOGS) }]),
  });
}

/**
 * Restores state after a service-worker restart. The debugger attachment itself
 * survives eviction, so a remembered tab is only trusted if Chrome still lists
 * it as attached — otherwise tools would fail against a tab that looks bound.
 */
async function rehydrate() {
  const saved = await chrome.storage.session.get({ attachments: [], ownedWindows: [], agentGroupId: null, tabState: [] });
  agentGroupId = saved.agentGroupId;
  ownedWindows = new Map();
  for (const [clientId, ids] of saved.ownedWindows ?? []) {
    const liveIds = new Set();
    for (const id of ids) {
      try {
        await chrome.windows.get(Number(id));
        liveIds.add(Number(id));
      } catch { /* stale ownership entries are discarded */ }
    }
    if (liveIds.size) ownedWindows.set(clientId, liveIds);
  }
  tabState = new Map((saved.tabState ?? []).map(([id, v]) => [Number(id), v]));
  attachments = new Map();

  const restored = new Map((saved.attachments ?? []).map(([cid, tab]) => [cid, Number(tab)]));
  if (restored.size) {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets(resolve));
    const live = new Set(targets.filter((t) => t.attached && typeof t.tabId === "number").map((t) => t.tabId));
    for (const [cid, tabId] of restored) if (live.has(tabId)) attachments.set(cid, tabId);
  }

  // The debugger attachment outlives the service worker, but the frame id and
  // navigation state do not — without re-deriving them, navigation events are
  // dropped and tools silently snapshot the outgoing page.
  for (const tabId of ownedTabs()) {
    const state = stateFor(tabId);
    state.nav = { startedAt: 0, pending: false };
    state.mainFrameId = await sendCommand({ tabId }, "Page.getFrameTree")
      .then((tree) => tree?.frameTree?.frame?.id ?? null)
      .catch(() => null);
  }
  await persist();
}

function ensureReady() {
  ready ??= rehydrate().catch(() => {});
  return ready;
}

/* ------------------------------------------------------------------ socket */

async function connect() {
  clearTimeout(reconnectTimer);
  await ensureReady();

  const { port, token, enabled } = await settings();
  if (!enabled) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const next = new WebSocket(`ws://127.0.0.1:${port}/extension${query}`);
  socket = next;

  next.onopen = () => {
    setBadge("on");
    // Socket traffic resets the MV3 idle timer (Chrome 116+), keeping this worker resident.
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (next.readyState === WebSocket.OPEN) next.send(JSON.stringify({ kind: "ping" }));
    }, PING_MS);
  };
  next.onclose = () => {
    // Only the live socket may clear the shared timer, or a replaced socket
    // would kill the keepalive belonging to its successor.
    if (socket !== next) return;
    socket = null;
    clearInterval(pingTimer);
    setBadge("off");
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
  next.onerror = () => next.close();
  next.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.kind !== "command") return;
    try {
      const result = await handle(message.command, String(message.clientId ?? "default"));
      reply({ kind: "reply", id: message.id, ok: true, result });
    } catch (error) {
      reply({ kind: "reply", id: message.id, ok: false, error: String(error?.message ?? error) });
    }
  };
}

function reply(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function notify(text) {
  reply({ kind: "notification", text });
}

function setBadge(state) {
  const [text, color] = BADGES[state] ?? BADGES.off;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

/** Flashes the toolbar badge so an idle bridge is visibly distinct from an acting one. */
function markBusy() {
  setBadge("busy");
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => setBadge(socket?.readyState === WebSocket.OPEN ? "on" : "off"), BUSY_LINGER_MS);
}

/* ----------------------------------------------------------------- helpers */

function requireAttached(clientId) {
  const tabId = attachments.get(clientId);
  if (tabId === undefined) {
    throw new Error("No tab attached. Call browser_attach (optionally with a tabId from browser_tabs) first.");
  }
  return { tabId };
}

function sendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params ?? {}, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`${method}: ${error.message}`));
      else resolve(result ?? null);
    });
  });
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (!error) return resolve();

      // Modern Chrome lets several debugger clients share a target, so this is
      // a rare fallback (older Chrome, or a client that demanded exclusivity).
      if (/another debugger/i.test(error.message)) {
        reject(
          new Error(
            `Tab ${tabId} refused a second debugger session. This is unusual — Chrome normally allows ` +
              `chrome-bridge-mcp to share a tab with DevTools and with other automation extensions. ` +
              `Close DevTools or the other extension on this tab, or pick a different tab from browser_tabs.`,
          ),
        );
        return;
      }
      if (/devtools/i.test(error.message)) {
        reject(new Error(`Cannot attach to tab ${tabId} because DevTools is open on it. Close DevTools and retry.`));
        return;
      }
      // Re-attaching to a tab we already own is a genuine no-op.
      if (/already attached/i.test(error.message)) return resolve();
      reject(new Error(error.message));
    });
  });
}

/** Tab ids currently held by any debugger client, ours included. */
function attachedTabIds() {
  return new Promise((resolve) => {
    chrome.debugger.getTargets((targets) => {
      void chrome.runtime.lastError;
      resolve(new Set((targets ?? []).filter((t) => t.attached && typeof t.tabId === "number").map((t) => t.tabId)));
    });
  });
}

/**
 * Releases one client's hold on a tab. The debugger session is only torn down
 * when no other client is still using that tab, so clients never disconnect
 * each other.
 */
async function releaseTab(clientId) {
  const tabId = attachments.get(clientId);
  if (tabId === undefined) return undefined;
  attachments.delete(clientId);

  if (![...attachments.values()].includes(tabId)) {
    tabState.delete(tabId);
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }
  await persist();
  return tabId;
}

/** Groups agent-created tabs so they are visually distinct from the user's own. */
async function groupAgentTab(tabId) {
  if (!chrome.tabGroups) return;
  try {
    const groupId = await chrome.tabs.group(agentGroupId !== null ? { tabIds: [tabId], groupId: agentGroupId } : { tabIds: [tabId] });
    agentGroupId = groupId;
    await chrome.tabGroups.update(groupId, { color: "green", title: "MCP agent" });
    await persist();
  } catch {
    // Tab groups are unavailable in some windows; grouping is cosmetic, so ignore.
  }
}

async function ungroupAgentTab(tabId) {
  if (!chrome.tabGroups || agentGroupId === null) return;
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    /* tab already gone */
  }
}

/* ---------------------------------------------------------------- commands */

async function handle(command, clientId) {
  await ensureReady();
  const myTab = attachments.get(clientId);

  switch (command.type) {
    case "status":
      return { attachedTabId: myTab ?? null, version: chrome.runtime.getManifest().version };

    case "busy":
      markBusy();
      return { ok: true };

    case "navState": {
      if (myTab === undefined) return { startedAt: 0, pending: false, now: Date.now() };
      const state = stateFor(myTab);
      return { ...state.nav, dialog: state.dialog, now: Date.now() };
    }

    case "focusTab": {
      // Chrome does not deliver synthesised input to a tab that is not the
      // active one in its window, so interactions silently do nothing.
      if (myTab === undefined) throw new Error("No tab attached.");
      const tab = await chrome.tabs.get(myTab);
      if (tab.active) return { activated: false };
      await chrome.tabs.update(myTab, { active: true });
      return { activated: true };
    }

    case "listTabs": {
      const [tabs, busy] = await Promise.all([chrome.tabs.query({}), attachedTabIds()]);
      return tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) => ({
          id: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? tab.pendingUrl ?? "",
          active: !!tab.active,
          windowId: tab.windowId,
          attached: tab.id === myTab,
          // Informational: Chrome multiplexes debugger sessions, so a tab held
          // by DevTools or another extension is still attachable.
          shared: busy.has(tab.id) && tab.id !== myTab,
        }));
    }

    case "attach": {
      let tabId = command.tabId;
      if (tabId === undefined || tabId === null) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active?.id) throw new Error("No active tab to attach to.");
        tabId = active.id;
      }
      const tab = await chrome.tabs.get(tabId);
      if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(tab.url ?? "")) {
        throw new Error(`Cannot attach to a browser-internal page (${tab.url}). Pick a http(s) tab.`);
      }

      // Chrome reports "another debugger is already attached" even when the
      // other debugger is us, so re-attaching is short-circuited here rather
      // than pattern-matched on the error string.
      const liveTargets = await attachedTabIds();
      if (myTab === tabId && liveTargets.has(tabId)) {
        return { id: tabId, title: tab.title ?? "", url: tab.url ?? "", reused: true };
      }
      if (myTab !== undefined && myTab !== tabId) await releaseTab(clientId);

      // Another client may already hold this tab; one debugger session serves both.
      if (!liveTargets.has(tabId) || ![...attachments.values()].includes(tabId)) {
        await attachDebugger(tabId);
      }
      attachments.set(clientId, tabId);

      const state = stateFor(tabId);
      state.logs = [];
      state.nav = { startedAt: 0, pending: false };
      state.dialog = null;

      // Network events are not consumed by any tool; leaving the domain disabled
      // avoids streaming the user's real traffic through the extension.
      for (const domain of ["Page", "Runtime", "Log", "DOM"]) {
        await sendCommand({ tabId }, `${domain}.enable`).catch(() => {});
      }
      state.mainFrameId = await sendCommand({ tabId }, "Page.getFrameTree")
        .then((tree) => tree?.frameTree?.frame?.id ?? null)
        .catch(() => null);
      await persist();
      return { id: tabId, title: tab.title ?? "", url: tab.url ?? "" };
    }

    case "detach": {
      const released = await releaseTab(clientId);
      if (released !== undefined) await ungroupAgentTab(released);
      return { ok: true };
    }

    case "newTab": {
      creatingOwnTab = true;
      let tab;
      try {
        tab = await chrome.tabs.create({ url: command.url, active: command.active !== false });
      } finally {
        creatingOwnTab = false;
      }
      await waitForTabLoad(tab.id);
      if (command.group !== false) await groupAgentTab(tab.id);
      return handle({ type: "attach", tabId: tab.id }, clientId);
    }

    case "newWindow": {
      creatingOwnTab = true;
      let created;
      try {
        created = await chrome.windows.create({
          url: command.url,
          focused: command.active !== false,
          type: "normal",
        });
      } finally {
        creatingOwnTab = false;
      }
      const tab = created?.tabs?.[0];
      if (created?.id === undefined || tab?.id === undefined) {
        throw new Error("Chrome did not return the created window and tab IDs.");
      }
      let owned = ownedWindows.get(clientId);
      if (!owned) ownedWindows.set(clientId, (owned = new Set()));
      owned.add(created.id);
      await persist();
      await waitForTabLoad(tab.id);
      if (command.group !== false) await groupAgentTab(tab.id);
      const attached = await handle({ type: "attach", tabId: tab.id }, clientId);
      return { ...attached, windowId: created.id };
    }

    case "closeWindow": {
      const windowId = Number(command.windowId);
      const owned = ownedWindows.get(clientId);
      if (!Number.isInteger(windowId) || !owned?.has(windowId)) {
        throw new Error("Saarathi may close only a Chrome window created by this MCP client.");
      }
      const tabs = await chrome.tabs.query({ windowId });
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        const otherOwner = [...attachments].find(([otherClient, tabId]) => tabId === tab.id && otherClient !== clientId);
        if (otherOwner) throw new Error(`Cannot close window ${windowId}: tab ${tab.id} is attached by another MCP client.`);
      }
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        if (attachments.get(clientId) === tab.id) await releaseTab(clientId);
      }
      await chrome.windows.remove(windowId);
      owned.delete(windowId);
      if (owned.size === 0) ownedWindows.delete(clientId);
      await persist();
      return { ok: true, windowId };
    }

    case "closeOwnedWindows": {
      const owned = ownedWindows.get(clientId);
      const closed = [];
      const skipped = [];
      for (const windowId of [...(owned ?? [])]) {
        const tabs = await chrome.tabs.query({ windowId });
        const shared = tabs.some((tab) => tab.id !== undefined && [...attachments].some(([otherClient, tabId]) => tabId === tab.id && otherClient !== clientId));
        if (shared) {
          skipped.push(windowId);
          continue;
        }
        for (const tab of tabs) {
          if (tab.id !== undefined && attachments.get(clientId) === tab.id) await releaseTab(clientId);
        }
        await chrome.windows.remove(windowId);
        closed.push(windowId);
        owned?.delete(windowId);
      }
      if (owned?.size === 0) ownedWindows.delete(clientId);
      await persist();
      return { closed, skipped };
    }

    case "closeTab": {
      const tabId = command.tabId ?? myTab;
      if (tabId === undefined || tabId === null) throw new Error("No tab to close.");
      for (const [cid, owned] of [...attachments]) if (owned === tabId) await releaseTab(cid);
      await chrome.tabs.remove(tabId);
      return { ok: true };
    }

    case "cdp":
      return sendCommand(requireAttached(clientId), command.method, command.params);

    case "handleDialog": {
      const target = requireAttached(clientId);
      const state = stateFor(target.tabId);
      await sendCommand(target, "Page.handleJavaScriptDialog", {
        accept: command.accept !== false,
        ...(command.promptText === undefined ? {} : { promptText: command.promptText }),
      });
      state.dialog = null;
      return { ok: true };
    }

    case "consoleLogs": {
      if (myTab === undefined) throw new Error("No tab attached.");
      return stateFor(myTab).logs.slice(-(command.limit ?? 100));
    }

    default:
      throw new Error(`Unknown command "${command.type}".`);
  }
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  // A cached page can finish loading before the listener attaches.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch {
    return;
  }
  await new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/* ------------------------------------------------------------------ events */

/** Clients currently attached to a tab, so notifications only reach the affected ones. */
function clientsFor(tabId) {
  return [...attachments].filter(([, id]) => id === tabId).map(([cid]) => cid);
}

function notifyTab(tabId, text) {
  const clientIds = clientsFor(tabId);
  if (clientIds.length) reply({ kind: "notification", text, clientIds });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  // Listeners can fire on a freshly-woken worker before state is restored.
  ensureReady().then(() => {
    if (!ownedTabs().has(tabId)) return;
    const state = stateFor(tabId);

    if (method === "Runtime.consoleAPICalled") {
      pushLog(state, params.type, (params.args ?? []).map(describeRemoteObject).join(" "));
    } else if (method === "Log.entryAdded") {
      pushLog(state, params.entry.level, params.entry.text, params.entry.url);
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails;
      pushLog(state, "error", details.exception?.description ?? details.text, details.url);
    } else if (method === "Page.frameStartedLoading" && (state.mainFrameId === null || params.frameId === state.mainFrameId)) {
      state.nav = { startedAt: Date.now(), pending: true };
    } else if (method === "Page.frameStoppedLoading" && (state.mainFrameId === null || params.frameId === state.mainFrameId)) {
      state.nav = { startedAt: state.nav.startedAt || Date.now(), pending: false };
    } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
      state.mainFrameId = params.frame.id;
      state.nav = { startedAt: Date.now(), pending: state.nav.pending };
      notifyTab(tabId, `Page navigated to ${params.frame.url}. Element refs from earlier snapshots are no longer valid.`);
    } else if (method === "Page.navigatedWithinDocument") {
      // SPA route change: no document swap, but the DOM is replaced wholesale.
      state.nav = { startedAt: Date.now(), pending: false };
      notifyTab(tabId, `Page changed route to ${params.url} without a reload. Take a fresh browser_snapshot.`);
    } else if (method === "Page.javascriptDialogOpening") {
      state.dialog = { type: params.type, message: params.message ?? "" };
      // beforeunload blocks every later evaluate; accept it so the agent cannot hang.
      if (params.type === "beforeunload") {
        sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        state.dialog = null;
        return;
      }
      notifyTab(
        tabId,
        `A ${params.type} dialog is open: ${JSON.stringify(params.message ?? "")}. ` +
          `Page inspection is blocked until it is dismissed — use browser_handle_dialog.`,
      );
    } else if (method === "Page.javascriptDialogClosed") {
      state.dialog = null;
    }
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  ensureReady().then(async () => {
    if (!ownedTabs().has(tabId)) return;
    notifyTab(tabId, `Debugger detached from tab ${tabId} (${reason}). Call browser_attach again to resume.`);
    for (const [cid, owned] of [...attachments]) if (owned === tabId) attachments.delete(cid);
    tabState.delete(tabId);
    await persist();
  });
});

// A click that opens a tab is otherwise invisible to the agent, which would
// keep inspecting the old page and get confused.
chrome.tabs.onCreated.addListener((tab) => {
  if (creatingOwnTab) return;
  ensureReady().then(() => {
    if (!attachments.size || ownedTabs().has(tab.id)) return;
    reply({
      kind: "notification",
      text:
        `A new tab (${tab.id}) was opened: ${tab.pendingUrl || tab.url || "about:blank"}. ` +
        `Use browser_attach with that tabId to work in it, or browser_close_tab to dismiss it.`,
      clientIds: [...attachments.keys()],
    });
  });
});

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current !== "complete") return;
    ensureReady().then(() => {
      if (!attachments.size) return;
      chrome.downloads.search({ id: delta.id }, (items) => {
        void chrome.runtime.lastError;
        const item = items && items[0];
        if (item) {
          reply({
            kind: "notification",
            text: `Download finished: ${item.filename} (${item.fileSize ?? "?"} bytes) from ${item.finalUrl || item.url}`,
            clientIds: [...attachments.keys()],
          });
        }
      });
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureReady().then(async () => {
    if (!ownedTabs().has(tabId)) return;
    notifyTab(tabId, `The attached tab (${tabId}) was closed.`);
    for (const [cid, owned] of [...attachments]) if (owned === tabId) attachments.delete(cid);
    tabState.delete(tabId);
    await persist();
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  ensureReady().then(async () => {
    for (const [clientId, ids] of ownedWindows) {
      ids.delete(windowId);
      if (ids.size === 0) ownedWindows.delete(clientId);
    }
    await persist();
  });
});

function describeRemoteObject(arg) {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type ?? "";
}

function pushLog(state, level, text, url) {
  state.logs.push({ level, text: String(text ?? "").slice(0, 2000), url });
  if (state.logs.length > MAX_LOGS) state.logs.shift();
}

/* --------------------------------------------------------------- lifecycle */

// Chrome clamps alarm periods to a 30s floor; this is the backstop if the socket drops.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getStatus") {
    ensureReady().then(() =>
      sendResponse({ connected: socket?.readyState === WebSocket.OPEN, attachedTabId: [...attachments.values()][0] ?? null, clients: attachments.size }),
    );
    return true;
  }
  if (message?.type === "reconnect") {
    socket?.close();
    socket = null;
    connect().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

connect();
