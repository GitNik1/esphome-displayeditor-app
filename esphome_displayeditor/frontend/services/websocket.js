// @ts-check

/** @typedef {{protocol: string, host: string, pathname: string}} SocketLocation */
/** @typedef {{addEventListener: (type: string, listener: (event: any) => void) => void,
 * close: () => void}} SocketLike */
/** @typedef {new (url: string) => SocketLike} SocketConstructor */

/** @param {SocketLocation} location @param {string} path */
export function websocketUrl(location, path) {
  const base = location.pathname.endsWith("/") ? location.pathname : `${location.pathname}/`;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${base}api/v1/${path}`;
}

/**
 * @param {{
 * path: string,
 * onMessage: (payload: unknown, socket: SocketLike) => void,
 * onOpen?: (socket: SocketLike) => void,
 * onClose?: (socket: SocketLike | null) => void,
 * reconnect?: boolean | (() => boolean),
 * reconnectDelay?: number,
 * location?: SocketLocation,
 * WebSocketClass?: SocketConstructor,
 * schedule?: (callback: () => void, delay: number) => number,
 * }} options
 */
export function createJsonSocket({
  path,
  onMessage,
  onOpen = () => {},
  onClose = () => {},
  reconnect = true,
  reconnectDelay = 3000,
  location = window.location,
  WebSocketClass = /** @type {SocketConstructor} */ (WebSocket),
  schedule = window.setTimeout.bind(window),
}) {
  /** @type {SocketLike | null} */
  let socket = null;
  /** @type {number | null} */
  let reconnectTimer = null;
  let stopped = false;

  const connect = () => {
    if (stopped || socket) return socket;
    const created = new WebSocketClass(websocketUrl(location, path));
    socket = created;
    created.addEventListener("open", () => onOpen(created));
    created.addEventListener("message", (message) => {
      let payload;
      try { payload = JSON.parse(message.data); } catch { return; }
      onMessage(payload, created);
    });
    created.addEventListener("close", () => {
      const closed = socket;
      socket = null;
      onClose(closed);
      const shouldReconnect = typeof reconnect === "function" ? reconnect() : reconnect;
      if (shouldReconnect && !stopped) reconnectTimer = schedule(connect, reconnectDelay);
    });
    return created;
  };

  return {
    connect,
    stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
    get socket() { return socket; },
  };
}
