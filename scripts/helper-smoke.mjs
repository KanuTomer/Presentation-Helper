import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const helper = join(root, "resources", "windows-helper", "PresenterAI.WindowsHelper.exe");
if (!existsSync(helper)) throw new Error("Bundled helper is missing. Run npm run helper:build first.");

const helperProcess = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stderr = "";
helperProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
function rejectPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
helperProcess.once("error", (error) => rejectPending(new Error(`Helper process error: ${error.code ?? error.message}`)));
helperProcess.once("exit", (code, signal) => {
  rejectPending(new Error(`Helper exited before completing a command (code ${code ?? "none"}, signal ${signal ?? "none"}).`));
});
createInterface({ input: helperProcess.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch {
    rejectPending(new Error("Helper returned malformed JSON during the smoke test."));
    helperProcess.kill();
    return;
  }
  if (!message.requestId) return;
  const waiter = pending.get(message.requestId);
  if (!waiter) return;
  pending.delete(message.requestId);
  clearTimeout(waiter.timer);
  if (message.type === "error") waiter.reject(new Error(`${message.code}: ${message.message}`));
  else waiter.resolve(message);
});

let nextId = 0;
function command(type, payload = {}, timeoutMs = 15_000) {
  const requestId = `smoke-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Helper ${type} command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    helperProcess.stdin.write(`${JSON.stringify({ type, requestId, ...payload })}\n`, (error) => {
      if (!error) return;
      const waiter = pending.get(requestId);
      if (!waiter) return;
      pending.delete(requestId);
      clearTimeout(waiter.timer);
      reject(new Error(`Helper ${type} command could not be written: ${error.code ?? error.message}`));
    });
  });
}

const outputs = [];
try {
  const hello = await command("hello", { protocolVersion: 2 });
  const requiredFeatures = ["wasapi-system-loopback", "device-selection", "hold-shortcut", "pcm16k-mono", "hook-ready", "single-file-capture", "bounded-capture", "capture-limit-events", "operation-ids"];
  if (hello.protocolVersion !== 2 || hello.shortcutReady !== true || requiredFeatures.some((feature) => !hello.features?.includes(feature))) {
    throw new Error(`Unexpected helper handshake: ${JSON.stringify(hello)}.`);
  }
  const deviceList = await command("listDevices");
  if (!Array.isArray(deviceList.devices) || deviceList.devices.length === 0) {
    throw new Error("No active Windows output device was found.");
  }

  const mediaDirectory = join(process.env.WINDIR ?? "C:\\Windows", "Media");
  const candidates = (await fs.readdir(mediaDirectory))
    .filter((name) => name.toLowerCase().endsWith(".wav"))
    .map((name) => join(mediaDirectory, name));
  const ranked = await Promise.all(candidates.map(async (path) => ({ path, size: (await fs.stat(path)).size })));
  ranked.sort((a, b) => b.size - a.size);
  if (!ranked[0]) throw new Error("No Windows Media WAV fixture is available.");
  const escaped = ranked[0].path.replaceAll("'", "''");
  const captures = [];
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const operationId = `smoke-operation-${Date.now()}-${cycle}`;
    const output = join(tmpdir(), `presenterai-helper-smoke-${Date.now()}-${cycle}.wav`);
    outputs.push(output);
    const started = await command("startCapture", { operationId, path: output });
    if (started.operationId !== operationId || !started.endpointId || !started.endpointName) {
      throw new Error(`Unexpected capture start metadata in cycle ${cycle}: ${JSON.stringify(started)}`);
    }
    const playback = spawnSync("powershell", ["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${escaped}').PlaySync()`], { encoding: "utf8" });
    if (playback.status !== 0) throw new Error(playback.stderr || `Windows audio playback failed in cycle ${cycle}.`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const stopped = await command("stopCapture", { operationId });
    if (stopped.sampleRate !== 16000 || stopped.channels !== 1 || stopped.durationMs < 250 || stopped.bytes <= 44) {
      throw new Error(`Unexpected capture metadata in cycle ${cycle}: ${JSON.stringify(stopped)}`);
    }
    if (stopped.operationId !== operationId || !["released", "maximum_duration", "maximum_size", "stopped"].includes(stopped.terminalReason)) {
      throw new Error(`Unexpected capture terminal metadata in cycle ${cycle}: ${JSON.stringify(stopped)}`);
    }
    captures.push(stopped);
  }
  console.log(JSON.stringify({ protocolVersion: hello.protocolVersion, deviceCount: deviceList.devices.length, captures }, null, 2));
} finally {
  try { await command("shutdown", {}, 5_000); } catch { helperProcess.kill(); }
  if (helperProcess.exitCode === null && !helperProcess.killed) helperProcess.kill();
  await Promise.all(outputs.map(async (output) => { try { await fs.unlink(output); } catch { } }));
  if (stderr.trim()) console.error(stderr.trim());
}
