import http from "node:http";
import { appendFileSync } from "node:fs";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync("/tmp/netwatch-webhook.log", `${new Date().toISOString()} ${req.url}\n${body}\n\n`);
    res.end("ok");
  });
}).listen(9999, "127.0.0.1", () => console.log("webhook receiver on :9999"));
