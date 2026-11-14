// Preloaded into the HeadTTS process (`node --import`) to choose which interface it listens on.
// HeadTTS calls server.listen(port) without a host, which binds every interface; browsers only
// reach TTS through a same-origin proxy (Vite in dev, Caddy in production), so loopback is enough.
// The host comes from TTS_HOST, which tts-server.mjs sets (default 127.0.0.1).
import net from "node:net";

const host = process.env.TTS_HOST;
if (host) {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    // listen(port[, backlog][, cb]) -> listen(port, host, ...); leave every other call form alone.
    const isPort = typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]));
    if (isPort && typeof args[1] !== "string") args.splice(1, 0, host);
    return listen.apply(this, args);
  };
}
