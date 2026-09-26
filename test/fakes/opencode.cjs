#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const root = process.env.MUSTER_FAKE_ROOT;
if (!root) throw new Error("Fake requires isolated root");

if (argv.includes("--version")) {
  console.log(process.env.MUSTER_FAKE_OPENCODE_VERSION || "1.18.31");
  process.exit(0);
}

if (argv.join(" ") === "--pure debug config") {
  if (process.env.MUSTER_FAKE_OPENCODE_DEBUG_EXIT === "1") {
    console.error("fake debug config failed");
    process.exit(8);
  }
  if (process.env.MUSTER_FAKE_OPENCODE_DEBUG_MALFORMED === "1") {
    console.log("{not-json");
    process.exit(0);
  }
  const inline = process.env.OPENCODE_CONFIG_CONTENT;
  if (!inline) {
    const names = (process.env.MUSTER_FAKE_OPENCODE_INHERITED_MCP || "")
      .split(",")
      .filter(Boolean);
    console.log(
      JSON.stringify({
        mcp: Object.fromEntries(names.map((name) => [name, { enabled: true }])),
      }),
    );
    process.exit(0);
  }
  const substitute = (value) => {
    if (typeof value === "string")
      return value.replace(
        /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (_, name) => process.env[name] || "",
      );
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, substitute(item)]),
      );
    return value;
  };
  const resolved = substitute(JSON.parse(inline));
  if (process.env.MUSTER_FAKE_OPENCODE_MANAGED_OVERRIDE === "1") {
    resolved.mcp ||= {};
    resolved.permission ||= {};
    resolved.mcp.unselected = { enabled: true };
    resolved.permission["unselected_*"] = "allow";
  }
  console.log(JSON.stringify(resolved));
  process.exit(0);
}

const configSummary = () => {
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
  return {
    mcp: Object.fromEntries(
      Object.entries(inline.mcp || {}).map(([name, config]) => [
        name,
        { enabled: config.enabled, type: config.type },
      ]),
    ),
    tools: inline.tools || {},
    configContentPresent: process.env.OPENCODE_CONFIG_CONTENT !== undefined,
    environmentKeys: ["HOME", "PATH", "TERM"].filter(
      (name) => process.env[name] !== undefined,
    ),
  };
};

if (argv[0] === "run") {
  const separator = argv.indexOf("--");
  const prompt = separator >= 0 ? argv.slice(separator + 1).join(" ") : "";
  fs.appendFileSync(
    path.join(root, "starts.jsonl"),
    JSON.stringify({
      runtime: "opencode",
      pid: process.pid,
      prompt,
      argv,
      cwd: fs.realpathSync(process.cwd()),
      ...configSummary(),
      intentPresent: fs.existsSync(
        path.join(process.env.MUSTER_TEST_HOME || root, "launches.jsonl"),
      ),
    }) + "\n",
  );
  console.log(
    JSON.stringify({
      type: "text",
      part: { text: `TASK_OUTPUT:${prompt}` },
    }),
  );
  setTimeout(
    () =>
      process.exit(Number(process.env.MUSTER_FAKE_OPENCODE_TASK_EXIT || "0")),
    Number(process.env.MUSTER_FAKE_TASK_MS || "100"),
  );
  return;
}

const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const port = Number(valueAfter("--port"));
const prompt = valueAfter("--prompt") || "untitled";
if (!Number.isInteger(port) || port <= 0) process.exit(2);

const id = randomUUID();
const created = Date.now();
const legacyReadyMs = process.env.MUSTER_FAKE_READY_MS || "0";
const healthReadyAt =
  created + Number(process.env.MUSTER_FAKE_OPENCODE_HEALTH_MS || legacyReadyMs);
const sessionReadyAt =
  created +
  Number(process.env.MUSTER_FAKE_OPENCODE_SESSION_MS || legacyReadyMs);
const statePath = path.join(root, `opencode-${id}.json`);
fs.writeFileSync(
  statePath,
  JSON.stringify({ title: prompt, status: { type: "busy" } }),
);
fs.appendFileSync(
  path.join(root, "starts.jsonl"),
  JSON.stringify({
    runtime: "opencode",
    pid: process.pid,
    id,
    port,
    prompt,
    argv,
    cwd: fs.realpathSync(process.cwd()),
    statePath,
    ...configSummary(),
    intentPresent: fs.existsSync(
      path.join(process.env.MUSTER_TEST_HOME || root, "launches.jsonl"),
    ),
  }) + "\n",
);

const current = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { title: prompt, status: { type: "busy" } };
  }
};
const session = () => ({
  id,
  title: current().title,
  directory:
    process.env.MUSTER_FAKE_OPENCODE_WRONG_CWD === "1"
      ? `${fs.realpathSync(process.cwd())}-other`
      : fs.realpathSync(process.cwd()),
  time: { created, updated: Date.now() },
});
const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const malformed = (response, kind) => {
  if (process.env.MUSTER_FAKE_OPENCODE_MALFORMED !== kind) return false;
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{not-json");
  return true;
};

const configuredStatus = () => {
  switch (process.env.MUSTER_FAKE_OPENCODE_STATUS) {
    case "idle":
      return { type: "idle" };
    case "busy":
    case "active":
      return { type: "busy" };
    case "retry":
      return {
        type: "retry",
        attempt: 2,
        message: "provider busy",
        next: Date.now() + 1000,
      };
    default:
      return undefined;
  }
};

const spawnOrphan = (childCode, info) => {
  const intermediate = String.raw`
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", process.env.MUSTER_FAKE_ORPHAN_CODE], { detached: true, stdio: "ignore", env: process.env });
child.unref();
`;
  spawn(process.execPath, ["-e", intermediate], {
    stdio: "ignore",
    env: {
      ...process.env,
      MUSTER_FAKE_ORPHAN_CODE: childCode,
      MUSTER_FAKE_ORPHAN_INFO: info,
    },
  });
};

if (
  process.env.MUSTER_FAKE_OPENCODE_PORT_SQUATTER === "1" ||
  process.env.MUSTER_FAKE_OPENCODE_PORT_COLLISION === "1"
) {
  const info = JSON.stringify({
    ownerPid: process.pid,
    port,
    id,
    title: prompt,
    directory: fs.realpathSync(process.cwd()),
    created,
    root,
  });
  const childCode = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const info = JSON.parse(process.env.MUSTER_FAKE_ORPHAN_INFO);
let detailRead = false;
const session = () => ({ id: info.id, title: info.title, directory: info.directory, time: { created: info.created, updated: Date.now() } });
const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/global/health") return json(response, 200, { healthy: true, version: "1.18.31" });
  if (request.method === "GET" && request.url === "/session") return json(response, 200, [session()]);
  if (request.method === "GET" && request.url === "/session/status") return json(response, 200, detailRead ? {} : { [info.id]: { type: "busy" } });
  if (request.method === "GET" && request.url === "/session/" + info.id) { detailRead = true; return json(response, 200, session()); }
  return json(response, 404, { error: "not found" });
});
server.listen(info.port, "127.0.0.1", () => fs.appendFileSync(path.join(info.root, "opencode-squatters.jsonl"), JSON.stringify({ pid: process.pid, port: info.port }) + "\n"));
setInterval(() => { try { process.kill(info.ownerPid, 0); } catch { server.close(() => process.exit(0)); } }, 50);
`;
  spawnOrphan(childCode, info);
  setInterval(() => {}, 1000);
} else {
  let initialTransitionComplete = false;

  const server = http.createServer((request, response) => {
    const healthReady = Date.now() >= healthReadyAt;
    const sessionReady = Date.now() >= sessionReadyAt;
    if (request.method === "GET" && request.url === "/global/health") {
      if (malformed(response, "health")) return;
      json(response, 200, { healthy: healthReady, version: "1.18.31" });
      return;
    }
    if (request.method === "GET" && request.url === "/session") {
      if (malformed(response, "session")) return;
      json(response, 200, sessionReady ? [session()] : []);
      return;
    }
    if (request.method === "GET" && request.url === `/session/${id}`) {
      if (malformed(response, "detail")) return;
      if (!initialTransitionComplete) {
        const state = current();
        fs.writeFileSync(
          statePath,
          JSON.stringify({ ...state, status: { type: "idle" } }),
        );
        initialTransitionComplete = true;
      }
      json(response, 200, session());
      return;
    }
    if (request.method === "GET" && request.url === "/session/status") {
      if (malformed(response, "status")) return;
      const status = current().status;
      if (status.reassignOnStatus === true) {
        const replacementInfo = JSON.stringify({
          ownerPid: process.pid,
          port,
          id,
          title: status.replacementTitle ?? "replacement",
          directory: fs.realpathSync(process.cwd()),
          created,
          root,
        });
        const replacementCode = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const info = JSON.parse(process.env.MUSTER_FAKE_ORPHAN_INFO);
const session = () => ({ id: info.id, title: info.title, directory: info.directory, time: { created: info.created, updated: Date.now() } });
const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/session/" + info.id + "/abort") { fs.appendFileSync(path.join(info.root, "opencode-replacement-aborts.jsonl"), JSON.stringify({ pid: process.pid, id: info.id }) + "\n"); return json(response, 200, true); }
  if (request.method === "GET" && request.url === "/global/health") return json(response, 200, { healthy: true, version: "1.18.31" });
  if (request.method === "GET" && request.url === "/session/" + info.id) return json(response, 200, session());
  if (request.method === "GET" && request.url === "/session/status") return json(response, 200, {});
  return json(response, 404, { error: "not found" });
});
const listen = () => server.listen(info.port, "127.0.0.1");
server.on("listening", () => fs.appendFileSync(path.join(info.root, "opencode-replacements.jsonl"), JSON.stringify({ pid: process.pid, port: info.port }) + "\n"));
server.on("error", error => { if (error.code === "EADDRINUSE") setTimeout(listen, 10); else process.exit(2); });
listen();
setInterval(() => { try { process.kill(info.ownerPid, 0); } catch { server.close(() => process.exit(0)); } }, 50);
`;
        spawnOrphan(replacementCode, replacementInfo);
        server.close();
        setTimeout(() => json(response, 200, { [id]: { type: "busy" } }), 150);
        setInterval(() => {}, 1000);
        return;
      }
      const selectedStatus = initialTransitionComplete
        ? configuredStatus()
        : undefined;
      const visibleStatus = selectedStatus || status;
      json(
        response,
        200,
        sessionReady && visibleStatus.type !== "idle"
          ? { [id]: visibleStatus }
          : {},
      );
      return;
    }
    if (request.method === "POST" && request.url === `/session/${id}/abort`) {
      fs.appendFileSync(
        path.join(root, "opencode-aborts.jsonl"),
        JSON.stringify({ id, pid: process.pid }) + "\n",
      );
      if (process.env.MUSTER_FAKE_OPENCODE_ABORT_FAIL === "1") {
        json(response, 503, { error: "abort failed" });
        return;
      }
      json(response, 200, true);
      return;
    }
    json(response, 404, { error: "not found" });
  });

  server.on("error", () => process.exit(7));
  server.listen(port, "127.0.0.1", () => {
    const exitMs = Number(process.env.MUSTER_FAKE_OPENCODE_EXIT_MS || "0");
    if (exitMs > 0) setTimeout(() => process.exit(9), exitMs);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => server.close(() => process.exit(0)));
}
