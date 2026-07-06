import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";

export const DEFAULT_PORT = 8787;
export const HOST = "127.0.0.1";

/**
 * Wire protocol version between hub host and guests.
 *
 * Bump whenever the envelope changes. A long-running process from an older
 * install keeps serving as host after an upgrade, and silently dropping a new
 * field is far worse than refusing to connect — that is exactly how per-client
 * tab isolation regressed into clients sharing one attachment.
 */
export const PROTOCOL_VERSION = 2;

/** A command sent from an MCP server instance towards the Chrome extension. */
export interface BridgeCommand {
  type: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type Role = "host" | "guest" | "offline";

/**
 * Transport broker between MCP server instances and the Chrome extension.
 *
 * The first process to start binds the port and becomes the `host`: it owns the
 * single extension socket and relays commands for everyone else. Later
 * processes find the port taken and attach as a `guest`, tunnelling their
 * commands through the host. This lets several coding tools (Claude Code,
 * Cursor, Copilot CLI, ...) share one browser connection instead of fighting
 * over the port.
 */
export class Hub {
  readonly port: number;
  /** Identifies this MCP process so the extension can keep per-client attachments apart. */
  readonly clientId: string = randomUUID();
  private readonly token: string;
  private readonly extensionOrigin?: string;
  private role: Role = "offline";
  private wss?: WebSocketServer;
  private extension?: WebSocket;
  private guests = new Set<WebSocket>();
  private guestIds = new WeakMap<WebSocket, string>();
  private upstream?: WebSocket;
  private pending = new Map<string, Pending>();
  private notifications: string[] = [];
  private closing = false;
  private incompatibleHost = false;

  constructor(port = DEFAULT_PORT, token = "", extensionId = "") {
    this.port = port;
    this.token = token;
    this.extensionOrigin = extensionId ? `chrome-extension://${extensionId}` : undefined;
  }

  async start(): Promise<Role> {
    try {
      await this.listen();
      this.role = "host";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      this.role = "guest";
      this.connectUpstream();
    }
    return this.role;
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: HOST,
        port: this.port,
        // Reject before the upgrade completes so a hostile page never holds an open socket.
        verifyClient: ({ req }, done) => {
          const parsed = new URL(req.url ?? "/", `http://${HOST}`);
          const pathname = parsed.pathname === "/extension" ? "/extension" : "/client";
          const denial = this.authorize(pathname, req.headers.origin, parsed.searchParams.get("token"));
          if (denial) {
            console.error(`[chrome-bridge] rejected ${pathname} connection: ${denial}`);
            done(false, 401, "Unauthorized");
            return;
          }
          done(true);
        },
      });
      const onError = (error: Error) => {
        wss.close();
        reject(error);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        wss.on("error", () => {});
        this.wss = wss;
        wss.on("connection", (socket, request) => this.onConnection(socket, request.url ?? "/"));
        resolve();
      });
    });
  }

  /**
   * Decides whether a handshake may proceed.
   *
   * Browsers always attach an `Origin` header to WebSocket handshakes and
   * cannot forge it, while WebSocket is exempt from CORS. Requiring an
   * extension origin on `/extension` and *no* origin on `/client` is therefore
   * what stops any random web page the user visits from opening this socket and
   * driving their browser. The token is defence in depth against local processes.
   */
  private authorize(pathname: string, origin: string | undefined, provided: string | null): string | null {
    if (this.token && provided !== this.token) return "invalid token";

    if (pathname === "/extension") {
      if (!origin) return "missing extension origin";
      if (!origin.startsWith("chrome-extension://")) return `origin ${origin} may not act as the extension`;
      if (this.extensionOrigin && origin !== this.extensionOrigin) return `origin ${origin} is not the pinned extension`;
      return null;
    }

    // Local MCP processes connect with a bare Node client, which sends no Origin.
    if (origin) return `origin ${origin} may not control the browser`;
    return null;
  }

  private onConnection(socket: WebSocket, url: string) {
    const parsed = new URL(url, `http://${HOST}`);

    if (parsed.pathname === "/extension") {
      this.extension?.close(4000, "replaced");
      this.extension = socket;
      socket.on("message", (data) => this.onExtensionMessage(data));
      socket.on("close", () => {
        if (this.extension === socket) this.extension = undefined;
      });
      return;
    }

    this.guests.add(socket);
    this.guestIds.set(socket, parsed.searchParams.get("cid") ?? "");
    send(socket, { kind: "hello", protocol: PROTOCOL_VERSION });
    socket.on("message", (data) => this.onGuestMessage(socket, data));
    socket.on("close", () => {
      this.guests.delete(socket);
      this.guestIds.delete(socket);
    });
  }

  /** Host: a relayed command arrived from another MCP process. */
  private async onGuestMessage(guest: WebSocket, data: RawData) {
    const message = safeParse(data);
    if (!message || message.kind !== "call") return;
    try {
      const result = await this.dispatchToExtension(
        message.command as BridgeCommand,
        message.timeoutMs as number,
        String(message.clientId ?? this.guestIds.get(guest) ?? ""),
      );
      send(guest, { kind: "reply", id: message.id, ok: true, result });
    } catch (error) {
      send(guest, { kind: "reply", id: message.id, ok: false, error: String((error as Error).message ?? error) });
    }
  }

  /** Host: the extension replied to a command, or pushed a notification. */
  private onExtensionMessage(data: RawData) {
    const message = safeParse(data);
    if (!message) return;
    if (message.kind === "notification") {
      const targets = Array.isArray(message.clientIds) ? (message.clientIds as string[]) : null;
      if (!targets || targets.includes(this.clientId)) this.pushNotification(String(message.text ?? ""));
      for (const guest of this.guests) {
        const id = this.guestIds.get(guest);
        if (!targets || (id && targets.includes(id))) send(guest, message);
      }
      return;
    }
    this.settle(String(message.id), message);
  }

  private settle(id: string, message: Record<string, unknown>) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(String(message.error ?? "browser command failed")));
  }

  /** Resolves once the host has announced a compatible protocol version. */
  private handshake?: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void };

  private connectUpstream() {
    if (this.closing) return;
    const params = new URLSearchParams({ cid: this.clientId });
    if (this.token) params.set("token", this.token);
    const socket = new WebSocket(`ws://${HOST}:${this.port}/client?${params}`);
    let greeted = false;
    socket.on("open", () => {
      // An older host never sends `hello`; treat silence as incompatible.
      setTimeout(() => {
        if (greeted || socket.readyState !== WebSocket.OPEN) return;
        console.error(
          `[chrome-bridge] the process holding port ${this.port} is an older chrome-bridge-mcp ` +
            `(no protocol handshake). Stop it and retry, or start this server with --port <other>.`,
        );
        this.incompatibleHost = true;
        socket.close(4426, "protocol too old");
      }, 2000);
    });
    socket.on("message", (data) => {
      const message = safeParse(data);
      if (!message) return;
      if (message.kind === "hello") {
        greeted = true;
        const remote = Number(message.protocol ?? 0);
        if (remote !== PROTOCOL_VERSION) {
          console.error(
            `[chrome-bridge] protocol mismatch on port ${this.port}: host speaks v${remote}, this build speaks ` +
              `v${PROTOCOL_VERSION}. Restart the other chrome-bridge-mcp process, or use --port <other>.`,
          );
          this.incompatibleHost = true;
          socket.close(4426, "protocol mismatch");
          return;
        }
        this.incompatibleHost = false;
        this.upstream = socket;
        return;
      }
      if (message.kind === "notification") {
        this.pushNotification(String(message.text ?? ""));
        return;
      }
      this.settle(String(message.id), message);
    });
    socket.on("close", () => {
      this.upstream = undefined;
      // The host may have exited and freed the port — try to take over before retrying.
      setTimeout(() => void this.recover(), 500);
    });
    socket.on("error", () => {});
  }

  /** Promotes this process to host if the port is free, otherwise keeps retrying as a guest. */
  private async recover() {
    if (this.closing || this.upstream) return;
    try {
      await this.listen();
      this.role = "host";
      console.error(`[chrome-bridge] previous hub exited; now hosting on ws://${HOST}:${this.port}`);
    } catch {
      this.connectUpstream();
    }
  }

  private pushNotification(text: string) {
    if (!text) return;
    this.notifications.push(text);
    if (this.notifications.length > 50) this.notifications.shift();
  }

  /** Drain browser-state notifications accumulated since the last call. */
  drainNotifications(): string[] {
    const drained = this.notifications;
    this.notifications = [];
    return drained;
  }

  get connected(): boolean {
    return this.role === "host" ? this.extension?.readyState === WebSocket.OPEN : this.upstream?.readyState === WebSocket.OPEN;
  }

  /** Waits briefly for a socket to come up, smoothing over startup and reconnect gaps. */
  private async awaitSocket(get: () => WebSocket | undefined, timeoutMs: number): Promise<WebSocket | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const socket = get();
      if (socket?.readyState === WebSocket.OPEN) return socket;
      if (Date.now() >= deadline || this.closing) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Send a command to Chrome and await its result. */
  async call(command: BridgeCommand, timeoutMs = 45_000): Promise<unknown> {
    if (this.role === "host") return this.dispatchToExtension(command, timeoutMs);

    // connectUpstream() is asynchronous, so the first call after start() can
    // arrive before the socket is open. Wait rather than failing spuriously.
    const upstream = await this.awaitSocket(() => this.upstream, 8000);
    if (!upstream) {
      throw new Error(
        this.incompatibleHost
          ? `Port ${this.port} is held by an incompatible (older) chrome-bridge-mcp process. Stop that process and retry, or start this one with --port <other>.`
          : "Not connected to the chrome-bridge hub. Is another chrome-bridge-mcp process still running?",
      );
    }
    const id = randomUUID();
    const promise = this.track(id, timeoutMs + 2000);
    send(upstream, { kind: "call", id, command, timeoutMs, clientId: this.clientId });
    return promise;
  }

  private async dispatchToExtension(command: BridgeCommand, timeoutMs = 45_000, clientId = this.clientId): Promise<unknown> {
    // MV3 service workers restart and reconnect, so tolerate a brief gap.
    const extension = await this.awaitSocket(() => this.extension, 3000);
    if (!extension) {
      throw new Error(
        "Chrome extension is not connected. Open Chrome, make sure the Chrome Bridge extension is installed and enabled, then click its toolbar icon to connect.",
      );
    }
    const id = randomUUID();
    const promise = this.track(id, timeoutMs);
    send(extension, { kind: "command", id, command, clientId });
    return promise;
  }

  private track(id: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async close() {
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("chrome-bridge hub closed"));
    }
    this.pending.clear();
    this.upstream?.close();
    this.extension?.close();
    for (const guest of this.guests) guest.close();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function safeParse(data: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data.toString());
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
