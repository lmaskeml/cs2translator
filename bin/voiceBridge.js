/**
 * Voice bridge — spawns Python WASAPI+Whisper worker and feeds transcripts
 * into the existing translate + console/GUI pipeline.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findVoicePython() {
  const venvPy = path.join(__dirname, "..", ".venv-voice", "Scripts", "python.exe");
  if (fs.existsSync(venvPy)) return venvPy;
  const venvPyUnix = path.join(__dirname, "..", ".venv-voice", "bin", "python");
  if (fs.existsSync(venvPyUnix)) return venvPyUnix;
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {number} opts.chunk
 * @param {string} [opts.device]
 * @param {string} [opts.language]
 * @param {(evt: object) => void} opts.onEvent
 * @param {(line: string) => void} [opts.onLog]
 */
export function startVoiceWorker(opts) {
  const py = findVoicePython();
  if (!py) {
    opts.onEvent({
      type: "error",
      message:
        "Voice venv missing. Run: .venv-voice setup (see requirements-voice.txt)"
    });
    return { stop() {} };
  }

  const worker = path.join(__dirname, "voice_worker.py");
  const args = [
    worker,
    "--model", opts.model || "tiny",
    "--chunk", String(opts.chunk || 2.8),
    "--energy", String(opts.energy ?? 35)
  ];
  if (opts.device && opts.device.toLowerCase() !== "auto") {
    args.push("--device", opts.device);
  } else {
    args.push("--device", "auto");
  }
  if (opts.language) args.push("--language", opts.language);
  if (opts.debug) args.push("--debug");

  const child = spawn(py, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
  });

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        opts.onEvent(JSON.parse(line));
      } catch {
        opts.onLog?.(`[voice raw] ${line}`);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const t = String(chunk).trim();
    if (t) opts.onLog?.(`[voice] ${t}`);
  });

  child.on("exit", (code) => {
    opts.onEvent({ type: "status", message: `Voice worker exited (code ${code})` });
  });

  return {
    stop() {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }
  };
}

export function voicePythonPath() {
  return findVoicePython();
}
