// Network switch for the WebKit e2e project. Playwright's WebKit offline emulation (context.setOffline) also fails
// every Blob read and every service-worker navigation, which iOS airplane mode does not do. WebKit therefore talks to
// the e2e server through this forward proxy, and "offline" means the proxy drops all connections: requests fail at the
// network like in airplane mode, while blob: URLs and the service worker keep working.
//   GET http://localhost:<port>/__network?offline=1|0   switch, returns {"offline": boolean}
import http from "node:http";
import net from "node:net";

export function startProxy(port) {
  let offline = false;
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/__network")) {
      const q = new URL(req.url, "http://proxy").searchParams;
      if (q.has("offline")) {
        offline = q.get("offline") === "1";
        if (offline) for (const s of sockets) s.destroy();
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Connection", "close");
      res.end(JSON.stringify({ offline }));
      return;
    }
    if (offline) return req.socket.destroy();
    const target = new URL(req.url);
    const upstream = http.request(
      { host: target.hostname === "localhost" ? "127.0.0.1" : target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      }
    );
    upstream.on("error", () => req.socket.destroy());
    track(req.socket);
    req.pipe(upstream);
  });
  server.on("connect", (req, client, head) => {
    if (offline) return client.destroy();
    const [host, p] = req.url.split(":");
    const upstream = net.connect(Number(p), host === "localhost" ? "127.0.0.1" : host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(client);
    track(upstream);
  });
  return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve(server)));
}
