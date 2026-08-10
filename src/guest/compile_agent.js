#!/usr/bin/env node
/**
 * Option A guest agent (not VS Code Server).
 *
 * Control port (framed JSON): PORT default 1234
 *   [u32be length][utf-8 JSON]
 *
 * Ops:
 *   ping | compile | write | read | list | mkdir | unlink | exec | stat | rename
 *
 * Shell port (raw bytes): SHELL_PORT default 1235
 *   Prefer `script` PTY → persistent /bin/sh -i (cd works).
 *   Fallback: line mode with sticky cwd.
 *
 * Workspace: WORK default /root/workspace.
 * Agent files live in /root/ucdvsc_server (not under workspace).
 * Absolute paths under /root and /tmp are allowed; "/" may be listed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const PORT = Number(process.env.PORT || 1234);
const SHELL_PORT = Number(process.env.SHELL_PORT || 1235);
const WORK = path.resolve(process.env.WORK || "/root/workspace");
const ALLOW_ROOTS = [path.resolve("/root"), path.resolve("/tmp")];

function ensureWork() {
  try {
    fs.mkdirSync(WORK, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function send(socket, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([hdr, body]));
}

function isAllowed(full) {
  const n = path.resolve(full);
  if (n === "/") {
    return true;
  }
  for (let i = 0; i < ALLOW_ROOTS.length; i++) {
    const root = ALLOW_ROOTS[i];
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (n === root || n.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** Relative → WORK; absolute → as-is. "/" and /root /tmp only. */
function safePath(userPath) {
  const raw = String(userPath == null || userPath === "" ? "." : userPath);
  let full;
  if (raw === "/" || raw.charAt(0) === "/") {
    full = path.resolve(raw);
  } else {
    full = path.resolve(WORK, raw.replace(/^\/+/, "") || ".");
  }
  if (!isAllowed(full)) {
    throw new Error("path not allowed: " + raw);
  }
  return full;
}

function absPosix(full) {
  const s = full.split(path.sep).join("/");
  return s || "/";
}

function handle(msg, socket) {
  if (!msg || typeof msg !== "object") {
    send(socket, { ok: false, op: "error", stderr: "invalid json", exit: 1 });
    return;
  }

  const op = msg.op;

  if (op === "ping") {
    send(socket, {
      ok: true,
      op: "ping",
      stdout: "pong",
      stderr: "",
      exit: 0,
      work: WORK,
    });
    return;
  }

  if (op === "stat") {
    try {
      const dest = safePath(msg.path || ".");
      const st = fs.statSync(dest);
      send(socket, {
        ok: true,
        op: "stat",
        path: absPosix(dest),
        type: st.isDirectory() ? "dir" : "file",
        size: st.size,
        mtime: st.mtimeMs,
        ctime: st.ctimeMs,
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "stat",
        stderr: String(e.message || e),
        exit: 1,
        code: "FileNotFound",
      });
    }
    return;
  }

  if (op === "rename") {
    try {
      const from = safePath(msg.from);
      const to = safePath(msg.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      send(socket, {
        ok: true,
        op: "rename",
        from: absPosix(from),
        to: absPosix(to),
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "rename",
        stderr: String(e.message || e),
        exit: 1,
      });
    }
    return;
  }

  if (op === "write") {
    try {
      const dest = safePath(msg.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Buffer.from(String(msg.base64 || ""), "base64").toString("utf8");
      fs.writeFileSync(dest, content, "utf8");
      send(socket, {
        ok: true,
        op: "write",
        path: absPosix(dest),
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "write",
        stderr: String(e.message || e),
        exit: 1,
      });
    }
    return;
  }

  if (op === "read") {
    try {
      const dest = safePath(msg.path);
      const content = fs.readFileSync(dest, "utf8");
      send(socket, {
        ok: true,
        op: "read",
        path: absPosix(dest),
        content: content,
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "read",
        stderr: String(e.message || e),
        exit: 1,
      });
    }
    return;
  }

  if (op === "list") {
    try {
      const dest = safePath(msg.path || ".");
      const names = fs.readdirSync(dest);
      const entries = names.map((name) => {
        const full = path.join(dest, name);
        let type = "file";
        try {
          const st = fs.statSync(full);
          type = st.isDirectory() ? "dir" : "file";
        } catch (e) {
          type = "unknown";
        }
        return { name: name, type: type, path: absPosix(full) };
      });
      send(socket, {
        ok: true,
        op: "list",
        path: absPosix(dest),
        entries: entries,
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "list",
        stderr: String(e.message || e),
        exit: 1,
      });
    }
    return;
  }

  if (op === "mkdir") {
    try {
      const dest = safePath(msg.path);
      fs.mkdirSync(dest, { recursive: true });
      send(socket, {
        ok: true,
        op: "mkdir",
        path: absPosix(dest),
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "mkdir",
        stderr: String(e.message || e),
        exit: 1,
      });
    }
    return;
  }

  if (op === "unlink") {
    try {
      const dest = safePath(msg.path);
      const st = fs.statSync(dest);
      if (st.isDirectory()) {
        fs.rmSync(dest, { recursive: !!msg.recursive, force: false });
      } else {
        fs.unlinkSync(dest);
      }
      send(socket, {
        ok: true,
        op: "unlink",
        path: absPosix(dest),
        exit: 0,
        stdout: "",
        stderr: "",
      });
    } catch (e) {
      send(socket, {
        ok: false,
        op: "unlink",
        stderr: String(e.message || e),
        exit: 1,
      });
    }
    return;
  }

  if (op === "exec") {
    const cmd = String(msg.cmd || "");
    if (!cmd) {
      send(socket, { ok: false, op: "exec", stderr: "empty cmd", exit: 1 });
      return;
    }
    const r = spawnSync("/bin/sh", ["-c", cmd], {
      cwd: WORK,
      encoding: "utf8",
      timeout: Number(msg.timeoutMs || 30000),
      maxBuffer: 2 * 1024 * 1024,
    });
    send(socket, {
      ok: r.status === 0,
      op: "exec",
      stdout: r.stdout || "",
      stderr: r.stderr || "",
      exit: r.status == null ? 1 : r.status,
    });
    return;
  }

  if (op === "compile") {
    const name =
      String(msg.name || "main.c").replace(/[^a-zA-Z0-9._/-]/g, "") || "main.c";
    const code = String(msg.code || "");
    let srcPath;
    try {
      srcPath = safePath(name);
      fs.mkdirSync(path.dirname(srcPath), { recursive: true });
      fs.writeFileSync(srcPath, code, "utf8");
    } catch (e) {
      send(socket, {
        ok: false,
        op: "compile",
        stderr: "write failed: " + e.message,
        exit: 1,
      });
      return;
    }

    const base = name.endsWith(".c") ? name.slice(0, -2) : name + ".out";
    let outBin;
    try {
      outBin = safePath(base);
    } catch (e) {
      outBin = path.join(WORK, "a.out");
    }

    const compile = spawnSync("gcc", [srcPath, "-o", outBin], {
      cwd: WORK,
      encoding: "utf8",
      timeout: 30000,
    });

    if (compile.status !== 0) {
      send(socket, {
        ok: false,
        op: "compile",
        stdout: compile.stdout || "",
        stderr: compile.stderr || "gcc failed",
        exit: compile.status == null ? 1 : compile.status,
      });
      return;
    }

    const run = spawnSync(outBin, [], {
      cwd: WORK,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });

    send(socket, {
      ok: run.status === 0,
      op: "compile",
      stdout: run.stdout || "",
      stderr: (compile.stderr || "") + (run.stderr || ""),
      exit: run.status == null ? 1 : run.status,
    });
    return;
  }

  send(socket, {
    ok: false,
    op: op || "unknown",
    stderr:
      "unsupported op (ping|compile|write|read|list|mkdir|unlink|exec|stat|rename)",
    exit: 1,
  });
}

function startControlServer() {
  const server = net.createServer((socket) => {
    let rx = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 4) {
        const len = rx.readUInt32BE(0);
        if (len > 16 * 1024 * 1024) {
          send(socket, { ok: false, stderr: "frame too large", exit: 1 });
          socket.destroy();
          return;
        }
        if (rx.length < 4 + len) {
          return;
        }
        const body = rx.subarray(4, 4 + len).toString("utf8");
        rx = rx.subarray(4 + len);
        let msg;
        try {
          msg = JSON.parse(body);
        } catch (e) {
          send(socket, { ok: false, stderr: "bad json: " + e.message, exit: 1 });
          continue;
        }
        try {
          handle(msg, socket);
        } catch (e) {
          send(socket, {
            ok: false,
            stderr: String((e && e.stack) || e),
            exit: 1,
          });
        }
      }
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log("agent control on 0.0.0.0:" + PORT + " work=" + WORK);
  });
}

function startShellServer() {
  const hasScript = (() => {
    try {
      return (
        spawnSync("script", ["-V"], { encoding: "utf8" }).status === 0 ||
        spawnSync("which", ["script"], { encoding: "utf8" }).status === 0
      );
    } catch (e) {
      return false;
    }
  })();

  const server = net.createServer((socket) => {
    const writeTxt = (text) => {
      if (!socket.writable) {
        return;
      }
      socket.write(String(text).replace(/\r?\n/g, "\r\n"));
    };

    // --- Persistent interactive shell via util-linux `script` (PTY) ---
    if (hasScript) {
      const sh = spawn(
        "script",
        ["-qfc", "/bin/sh -i", "/dev/null"],
        {
          cwd: WORK,
          env: Object.assign({}, process.env, {
            HOME: "/root",
            TERM: "xterm-256color",
            PS1: "guest:\\w\\$ ",
          }),
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      writeTxt("__UCD_PTY__\r\n");

      socket.on("data", (chunk) => {
        if (!sh.stdin.writable) {
          return;
        }
        const s = chunk
          .toString("binary")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        sh.stdin.write(Buffer.from(s, "binary"));
      });

      const forward = (chunk) => {
        if (!socket.writable) {
          return;
        }
        const text = Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
        socket.write(text.replace(/\r?\n/g, "\r\n"));
      };
      sh.stdout.on("data", forward);
      sh.stderr.on("data", forward);

      const cleanup = () => {
        try {
          sh.kill("SIGTERM");
        } catch (e) {
          /* ignore */
        }
        try {
          socket.destroy();
        } catch (e) {
          /* ignore */
        }
      };
      sh.on("exit", () => {
        try {
          socket.end();
        } catch (e) {
          /* ignore */
        }
      });
      socket.on("close", cleanup);
      socket.on("error", cleanup);
      sh.on("error", (err) => {
        writeTxt(String(err.message || err) + "\n");
        cleanup();
      });
      return;
    }

    // --- Fallback: line mode with sticky cwd (cd works across lines) ---
    let lineBuf = "";
    let busy = false;
    const queue = [];
    let cwd = WORK;

    const prompt = () => {
      const rel =
        cwd === WORK ? "~" : path.relative(WORK, cwd) || cwd;
      writeTxt("guest:" + rel + "$ ");
    };

    const runLine = (line) => {
      return new Promise((resolve) => {
        const trimmed = line.replace(/\0/g, "").trimEnd();
        if (trimmed.trim() === "") {
          resolve();
          return;
        }

        // Builtin cd so directory persists without a PTY
        const cdMatch = trimmed.match(/^\s*cd(?:\s+(.*))?$/);
        if (cdMatch) {
          let target = (cdMatch[1] || "").trim() || "/root";
          if (
            (target.startsWith('"') && target.endsWith('"')) ||
            (target.startsWith("'") && target.endsWith("'"))
          ) {
            target = target.slice(1, -1);
          }
          const next = path.resolve(cwd, target || ".");
          try {
            if (!fs.statSync(next).isDirectory()) {
              writeTxt("cd: not a directory: " + target + "\n");
            } else {
              cwd = next;
            }
          } catch (e) {
            writeTxt("cd: " + String(e.message || e) + "\n");
          }
          resolve();
          return;
        }

        const child = spawn("/bin/sh", ["-c", trimmed], {
          cwd: cwd,
          env: Object.assign({}, process.env, {
            HOME: "/root",
            TERM: "xterm-256color",
            PWD: cwd,
          }),
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.on("data", (chunk) => writeTxt(chunk.toString("utf8")));
        child.stderr.on("data", (chunk) => writeTxt(chunk.toString("utf8")));
        child.on("error", (err) => {
          writeTxt(String(err.message || err) + "\n");
          resolve();
        });
        child.on("close", (code) => {
          if (code != null && code !== 0) {
            writeTxt("[exit " + code + "]\n");
          }
          resolve();
        });
      });
    };

    const pump = async () => {
      if (busy) {
        return;
      }
      busy = true;
      while (queue.length > 0) {
        const line = queue.shift();
        try {
          await runLine(line);
        } catch (e) {
          writeTxt(String(e && e.message ? e.message : e) + "\n");
        }
        prompt();
      }
      busy = false;
    };

    writeTxt("__UCD_LINE__\n");
    prompt();

    socket.on("data", (chunk) => {
      const s = chunk
        .toString("utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      lineBuf += s;
      let n;
      while ((n = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, n);
        lineBuf = lineBuf.slice(n + 1);
        queue.push(line);
      }
      void pump();
    });

    const cleanup = () => {
      queue.length = 0;
      try {
        socket.destroy();
      } catch (e) {
        /* ignore */
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  server.listen(SHELL_PORT, "0.0.0.0", () => {
    console.log(
      "agent shell on 0.0.0.0:" +
        SHELL_PORT +
        (hasScript ? " (script/PTY)" : " (line+cwd)")
    );
  });
}

ensureWork();
startControlServer();
// Defer shell bind slightly so control port comes up first under slow v86.
setTimeout(startShellServer, 500);
