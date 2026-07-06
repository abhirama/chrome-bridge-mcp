const $ = (id) => document.getElementById(id);

async function refresh() {
  const { port, token } = await chrome.storage.local.get({ port: 8787, token: "" });
  $("port").value = port;
  $("token").value = token;

  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    const connected = !!status?.connected;
    $("dot").classList.toggle("on", connected);
    $("state").textContent = connected ? "Connected to MCP server" : "Waiting for MCP server…";
    $("attached").textContent = status?.attachedTabId
      ? `Controlling tab ${status.attachedTabId}.`
      : "No tab is being controlled.";
  });
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    port: Number($("port").value) || 8787,
    token: $("token").value.trim(),
    enabled: true,
  });
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 400));
});

refresh();
setInterval(refresh, 1500);
