import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createTaskboardServer, resolveHost, resolvePort } from "./app.mjs";

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";

async function main() {
  const pendingInjectorRequests = new Map();
  const onInjectorMessage = (message) => {
    if (message?.type !== "taskboard:child-session-response") return;
    const pending = pendingInjectorRequests.get(message.requestId);
    if (!pending) return;
    pendingInjectorRequests.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  };
  process.on("message", onInjectorMessage);
  const createChildSession = (payload) => {
    if (typeof process.send !== "function") {
      throw new Error("The Codex child-session bridge is unavailable");
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingInjectorRequests.delete(requestId);
        reject(new Error("The Codex child-session bridge timed out"));
      }, 30_000);
      timer.unref?.();
      pendingInjectorRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      process.send({
        type: "taskboard:child-session-request",
        requestId,
        payload,
      });
    });
  };
  const app = createTaskboardServer({ createChildSession });
  const host = resolveHost();
  const listenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
    ? null
    : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
  const address = await app.listen({ host, port: resolvePort(), fd: listenFd });
  console.log(`Codex Taskboard listening on http://127.0.0.1:${address.port}`);
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Codex Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.off("message", onInjectorMessage);
    for (const pending of pendingInjectorRequests.values()) {
      pending.reject(new Error("The Taskboard service is closing"));
    }
    pendingInjectorRequests.clear();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
