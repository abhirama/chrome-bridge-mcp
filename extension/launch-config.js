/**
 * Launcher-supplied connection settings.
 *
 * A deployment that starts Chrome itself (e.g. a systemd unit) writes
 * `launch.json` — `{"port": <1-65535>, "token": "<string>"}` — into the unpacked
 * extension directory, so no one has to type the token into the popup. It must
 * never be listed in `web_accessible_resources`: the extension ID is fixed by
 * the manifest `key`, so a web page could otherwise fetch the token.
 *
 * Anything missing or malformed falls back to the popup's stored settings.
 */

/** @returns {{port: number, token: string} | null} */
export function parseLaunchConfig(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { port, token } = value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== "string" || token === "") return null;
  return { port, token };
}

/** Launch config, when valid, overrides the stored port and token; `enabled` stays the user's. */
export function resolveSettings(stored, launchText) {
  const launch = launchText == null ? null : parseLaunchConfig(launchText);
  return launch ? { ...stored, ...launch } : stored;
}

export async function readLaunchText(getURL = (p) => chrome.runtime.getURL(p)) {
  try {
    const res = await fetch(getURL("launch.json"));
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
