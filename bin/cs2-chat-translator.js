#!/usr/bin/env node
/**
 * CS2 Sesli Translator (CLI + Web GUI)
 * ===================================
 *
 * Yazılı sohbet (console.log) + isteğe bağlı sesli çeviri (WASAPI + Whisper).
 * Depo: https://github.com/lmaskeml/cs2translator
 *
 * Same tool you had before, now with a local web UI at http://localhost:7420.
 *
 * Modes
 * -----
 *   cs2-chat-translator                 # start watcher + web GUI, open browser
 *   cs2-chat-translator --no-browser    # start watcher + web GUI, do not open browser
 *   cs2-chat-translator --port 1234     # change the web GUI port
 *   cs2-chat-translator --cli           # headless: watcher only, no web GUI (old behavior)
 *   cs2-chat-translator --init-config   # create/refresh config.json
 *   cs2-chat-translator --set-log-path /path/to/console.log
 *   cs2-chat-translator --set-cfg-dir  /path/to/cfg
 *   cs2-chat-translator --set-bind-key l
 *
 * The GUI shows a live chat feed, surfaces auto-translations inline, and lets
 * you edit the config (logPath, cfgDir, bindKey, auto-translate target) without
 * leaving the app. All chat-command handling (tm_<lang>, _tl, code_<lang>) is
 * unchanged.
 *
 * Runtime dependencies (unchanged from the CLI version)
 * -----------------------------------------------------
 *   nodejs 18+, xdotool, google-translate-api-x, chalk, fuzzball
 *   No new dependencies are added for the GUI — it uses Node's built-in http
 *   module and Server-Sent Events.
 */

import fs from "fs";
import http from "http";
import readline from "readline";
import { exec as execChild, spawnSync } from "child_process";
import translate from "google-translate-api-x";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import chalk from "chalk";
import * as fuzz from "fuzzball";
import { startVoiceWorker, voicePythonPath } from "./voiceBridge.js";

// -----------------------------------------------------------------------------
// File / path utilities and configuration handling
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let LOG_PATH = "";
let CSGO_CFG_DIR = "";
let CHAT_CFG = "";
let BIND_KEY = "l";
let AUTO_TRANSLATE_TARGET = "en";
let AUTO_TRANSLATE = true;
let RELAY_TO_CHAT = false;
let MY_NAME = "";
let OUTGOING_TARGET = "en";
let TRANSLATE_OUTGOING = true;
let lastChatSendAt = 0;
let VOICE_ENABLED = false;
let VOICE_MODEL = "tiny";
let VOICE_CHUNK = 3.5;
let VOICE_DEVICE = "";
let voiceHandle = null;

// Chat-tag prefixes used by the CS2 client. These differ per client language
// (e.g. Russian / Chinese clients use different strings). Users configure them.
let TAG_CT = "CT";
let TAG_T = "T";
let TAG_ALL = "ALL";
let TAG_REGEX = null;

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Common localized / alternate chat tags seen across CS2 clients.
// Always accepted in addition to the user-configured tags.
const BUILTIN_TAG_ALIASES = {
  CT: ["CT", "KT"],           // KT = Karşı Terörist (TR)
  T: ["T"],
  ALL: ["ALL", "HERKES"]      // HERKES = Turkish "everyone"
};

function rebuildTagRegex() {
  const tags = new Set(
    [TAG_CT, TAG_T, TAG_ALL, ...BUILTIN_TAG_ALIASES.CT, ...BUILTIN_TAG_ALIASES.T, ...BUILTIN_TAG_ALIASES.ALL]
      .filter((t) => t && String(t).trim().length)
      .map((t) => String(t).trim())
  );
  if (!tags.size) { TAG_REGEX = null; return; }
  const alt = [...tags].map(escapeForRegex).join("|");
  // Allow optional whitespace after ':' — CS2 clients vary slightly.
  TAG_REGEX = new RegExp(`\\[(${alt})\\]\\s+([^:]+):\\s*(.+)`, "i");
}

function canonicalizeTeam(matchedTag) {
  const tag = String(matchedTag || "");
  const ctSet = new Set([TAG_CT, ...BUILTIN_TAG_ALIASES.CT].map((t) => t.toLowerCase()));
  const tSet = new Set([TAG_T, ...BUILTIN_TAG_ALIASES.T].map((t) => t.toLowerCase()));
  const low = tag.toLowerCase();
  if (ctSet.has(low)) return "CT";
  if (tSet.has(low)) return "T";
  return "ALL";
}

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "cs2-chat-translator")
  : process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "cs2-chat-translator")
    : path.join(os.homedir(), ".config", "cs2-chat-translator");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const guessedRoot = process.platform === 'win32'
  ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam", "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo")
  : path.join(os.homedir(), ".local/share/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo");

const defaultConfig = {
  logPath: path.join(guessedRoot, "console.log"),
  cfgDir: path.join(guessedRoot, "cfg"),
  bindKey: "l",
  autoTranslate: true,
  autoTranslateTarget: "tr",
  // Send incoming auto-translations into CS2 chat via bind (say). OFF = console only.
  relayToChat: false,
  // Your in-game name — used to translate YOUR messages out to teammates.
  myName: "",
  // When you chat in another language, auto-send a translation to this lang.
  outgoingTarget: "en",
  translateOutgoing: true,
  // Voice: WASAPI loopback → Whisper → translate → console (never auto-say)
  voiceEnabled: false,
  voiceModel: "tiny",
  voiceChunkSec: 3.5,
  voiceDevice: "",
  tagCT: "CT",
  tagT: "T",
  tagAll: "ALL"
};

function pickConfig(cfg = {}) {
  return {
    logPath: cfg.logPath || defaultConfig.logPath,
    cfgDir: cfg.cfgDir || defaultConfig.cfgDir,
    bindKey: cfg.bindKey || defaultConfig.bindKey,
    autoTranslate:
      typeof cfg.autoTranslate === "boolean"
        ? cfg.autoTranslate
        : defaultConfig.autoTranslate,
    autoTranslateTarget:
      cfg.autoTranslateTarget || defaultConfig.autoTranslateTarget,
    relayToChat:
      typeof cfg.relayToChat === "boolean"
        ? cfg.relayToChat
        : defaultConfig.relayToChat,
    myName:
      typeof cfg.myName === "string"
        ? cfg.myName
        : typeof cfg.myUsername === "string"
          ? cfg.myUsername
          : defaultConfig.myName,
    outgoingTarget: cfg.outgoingTarget || defaultConfig.outgoingTarget,
    translateOutgoing:
      typeof cfg.translateOutgoing === "boolean"
        ? cfg.translateOutgoing
        : defaultConfig.translateOutgoing,
    voiceEnabled:
      typeof cfg.voiceEnabled === "boolean"
        ? cfg.voiceEnabled
        : defaultConfig.voiceEnabled,
    voiceModel: cfg.voiceModel || defaultConfig.voiceModel,
    voiceChunkSec:
      typeof cfg.voiceChunkSec === "number"
        ? cfg.voiceChunkSec
        : defaultConfig.voiceChunkSec,
    voiceDevice:
      typeof cfg.voiceDevice === "string"
        ? cfg.voiceDevice
        : defaultConfig.voiceDevice,
    tagCT: cfg.tagCT || defaultConfig.tagCT,
    tagT: cfg.tagT || defaultConfig.tagT,
    tagAll: cfg.tagAll || defaultConfig.tagAll
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...defaultConfig };
    const txt = fs.readFileSync(CONFIG_PATH, "utf8").trim();
    if (!txt) return { ...defaultConfig };
    return pickConfig(JSON.parse(txt));
  } catch (err) {
    console.error(chalk.red(`Failed to load config: ${err.message}`));
    return { ...defaultConfig };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const merged = pickConfig(cfg);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } catch (err) {
    console.error(chalk.red(`Failed to write config: ${err.message}`));
    process.exit(1);
  }
}

function initConfigCli() {
  const merged = saveConfig(loadConfig());
  console.log(chalk.green("Config initialized/updated:"));
  console.log(`  ${CONFIG_PATH}`);
  console.log("Effective values:");
  for (const [k, v] of Object.entries(merged)) console.log(`  ${k}: ${v}`);
}

function updateConfigKey(key, value) {
  const cfg = loadConfig();
  cfg[key] = value;
  const merged = saveConfig(cfg);
  console.log(chalk.green(`Config updated (${key}):`));
  console.log(`  ${CONFIG_PATH}`);
  console.log(`  ${key}: ${merged[key]}`);
}

function setupFromConfig() {
  const cfg = loadConfig();
  LOG_PATH = cfg.logPath;
  CSGO_CFG_DIR = cfg.cfgDir;
  BIND_KEY = cfg.bindKey || "l";
  AUTO_TRANSLATE = cfg.autoTranslate !== false;
  AUTO_TRANSLATE_TARGET = cfg.autoTranslateTarget || "tr";
  RELAY_TO_CHAT = cfg.relayToChat === true;
  MY_NAME = (cfg.myName || "").trim();
  OUTGOING_TARGET = (cfg.outgoingTarget || "en").toLowerCase();
  TRANSLATE_OUTGOING = cfg.translateOutgoing !== false;
  VOICE_ENABLED = cfg.voiceEnabled === true;
  VOICE_MODEL = cfg.voiceModel || "tiny";
  VOICE_CHUNK = typeof cfg.voiceChunkSec === "number" ? cfg.voiceChunkSec : 3.5;
  VOICE_DEVICE = (cfg.voiceDevice || "").trim();
  TAG_CT = cfg.tagCT || defaultConfig.tagCT;
  TAG_T = cfg.tagT || defaultConfig.tagT;
  TAG_ALL = cfg.tagAll || defaultConfig.tagAll;
  rebuildTagRegex();
  CHAT_CFG = path.join(CSGO_CFG_DIR, "chat_reader.cfg");
  ensureChatBridge();
}

function normalizePlayerName(name) {
  return String(name || "")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isMyMessage(sender) {
  if (!MY_NAME) return false;
  const a = normalizePlayerName(sender);
  const b = normalizePlayerName(MY_NAME);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** True for lines we (or tm_/_tl) already injected — translating again causes loops. */
function looksLikeTranslatedOutput(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.includes("→") || t.includes("->")) return true;
  if (/\bsaid\s*-/i.test(t)) return true;
  if (/\(from\s+[^)]+\)/i.test(t)) return true;
  // Tagged relays: [TR] name: ..., [EN] ..., [YOU→EN] ...
  if (/^\[[A-Za-z]{2,6}(?:→[A-Za-z]{2,6})?\]\s/u.test(t)) return true;
  if (/^\[YOU\b/i.test(t)) return true;
  return false;
}

function ensureChatBridge() {
  if (!CSGO_CFG_DIR) return;
  try {
    fs.mkdirSync(CSGO_CFG_DIR, { recursive: true });
    if (!fs.existsSync(CHAT_CFG)) {
      fs.writeFileSync(
        CHAT_CFG,
        "// Auto-generated by CS2 Chat Translator\necho CS2_Chat_Translator_ready\n",
        "utf8"
      );
    }
    // Keep bind present across optimizer cfg rewrites.
    const bindsPath = path.join(CSGO_CFG_DIR, "binds.cfg");
    const bindLine = `bind "${BIND_KEY}" "exec chat_reader"`;
    if (fs.existsSync(bindsPath)) {
      const txt = fs.readFileSync(bindsPath, "utf8");
      if (!new RegExp(`bind\\s+"?${escapeForRegex(BIND_KEY)}"?\\s+"exec chat_reader`, "i").test(txt)) {
        fs.appendFileSync(bindsPath, `\r\n// CS2 Chat Translator\r\n${bindLine}\r\n`, "utf8");
        log(sym.cfg, `Added bind to binds.cfg: ${bindLine}`);
      }
    } else {
      fs.writeFileSync(
        bindsPath,
        `// CS2 Chat Translator\r\n${bindLine}\r\n`,
        "utf8"
      );
    }
  } catch (err) {
    log(sym.warn, chalk.yellow(`Chat bridge setup failed: ${err.message}`));
  }
}

// -----------------------------------------------------------------------------
// Console styling utilities
// -----------------------------------------------------------------------------

const sym = {
  start: chalk.cyan("🚀"),
  info: chalk.cyan("ℹ️"),
  ok: chalk.green("✅"),
  warn: chalk.yellow("⚠️"),
  err: chalk.red("❌"),
  chat: chalk.magenta("💬"),
  trans: chalk.blueBright("🌍"),
  cfg: chalk.white("📝")
};

function log(prefix, msg) {
  console.log(prefix, msg);
}

function logKV(key, value) {
  console.log(chalk.gray(`   ${key}:`), chalk.white(value));
}

// -----------------------------------------------------------------------------
// Language mapping and auto-translate configuration
// -----------------------------------------------------------------------------

const LANG_MAP = {
  af:"Afrikaans", sq:"Albanian", am:"Amharic", ar:"Arabic", hy:"Armenian",
  az:"Azerbaijani", eu:"Basque", be:"Belarusian", bn:"Bengali", bs:"Bosnian",
  bg:"Bulgarian", ca:"Catalan", ceb:"Cebuano", ny:"Chichewa", zh:"Chinese",
  zh_cn:"Chinese (Simplified)", zh_tw:"Chinese (Traditional)", co:"Corsican",
  hr:"Croatian", cs:"Czech", da:"Danish", nl:"Dutch", en:"English",
  eo:"Esperanto", et:"Estonian", tl:"Filipino", fi:"Finnish", fr:"French",
  fy:"Frisian", gl:"Galician", ka:"Georgian", de:"German", el:"Greek",
  gu:"Gujarati", ht:"Haitian Creole", ha:"Hausa", haw:"Hawaiian", he:"Hebrew",
  hi:"Hindi", hmn:"Hmong", hu:"Hungarian", is:"Icelandic", ig:"Igbo",
  id:"Indonesian", ga:"Irish", it:"Italian", ja:"Japanese", jw:"Javanese",
  kn:"Kannada", kk:"Kazakh", km:"Khmer", rw:"Kinyarwanda", ko:"Korean",
  ku:"Kurdish (Kurmanji)", ky:"Kyrgyz", lo:"Lao", la:"Latin", lv:"Latvian",
  lt:"Lithuanian", lb:"Luxembourgish", mk:"Macedonian", mg:"Malagasy",
  ms:"Malay", ml:"Malayalam", mt:"Maltese", mi:"Maori", mr:"Marathi",
  mn:"Mongolian", my:"Myanmar (Burmese)", ne:"Nepali", no:"Norwegian",
  or:"Odia (Oriya)", ps:"Pashto", fa:"Persian", pl:"Polish", pt:"Portuguese",
  pa:"Punjabi", ro:"Romanian", ru:"Russian", sm:"Samoan", gd:"Scots Gaelic",
  sr:"Serbian", st:"Sesotho", sn:"Shona", sd:"Sindhi", si:"Sinhala",
  sk:"Slovak", sl:"Slovenian", so:"Somali", es:"Spanish", su:"Sundanese",
  sw:"Swahili", sv:"Swedish", tg:"Tajik", ta:"Tamil", tt:"Tatar", te:"Telugu",
  th:"Thai", tr:"Turkish", tk:"Turkmen", uk:"Ukrainian", ur:"Urdu",
  ug:"Uyghur", uz:"Uzbek", vi:"Vietnamese", cy:"Welsh", xh:"Xhosa",
  yi:"Yiddish", yo:"Yoruba", zu:"Zulu"
};

const PREFER_RU_FOR_CYRILLIC = true;
const CYRILLIC_REGEX = /[\u0400-\u04FF]/;

// -----------------------------------------------------------------------------
// SSE broadcast plumbing for the web GUI
// -----------------------------------------------------------------------------

const sseClients = new Set();
const recentEvents = [];
const MAX_RECENT = 300;

function broadcast(type, payload) {
  const evt = { type, payload, at: Date.now() };
  recentEvents.push(evt);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
  const data = `event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client gone, will be cleaned up */ }
  }
}

// -----------------------------------------------------------------------------
// Low-level helpers: CFG writing and key press simulation
// -----------------------------------------------------------------------------

function escapeForCfg(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeChatCfg({ message, team = false }) {
  if (!CHAT_CFG) {
    log(sym.err, "CHAT_CFG path not set — check cfgDir in config");
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(CHAT_CFG), { recursive: true });
    const safe = escapeForCfg(message);
    const cmd = team ? `say_team "${safe}"` : `say "${safe}"`;
    fs.writeFileSync(
      CHAT_CFG,
      `// Auto-generated by CS2 Chat Translator\n${cmd}\n`,
      "utf8"
    );
    log(sym.cfg, `Wrote to cfg: ${team ? "say_team" : "say"} → ${message}`);
    broadcast("cfg", { team, message });
    return true;
  } catch (err) {
    log(sym.err, chalk.red(`Failed to write chat_reader.cfg: ${err.message}`));
    broadcast("error", { message: `cfg write failed: ${err.message}` });
    return false;
  }
}

const chatSendQueue = [];
let chatSendBusy = false;
const recentlySentMessages = new Map(); // normalized text -> expiry ms
const MAX_CHAT_QUEUE = 5;
const CHAT_SETTLE_MS = 420;   // wait for in-game chat UI to close
const CHAT_GAP_MS = 520;      // min gap between two successful sends
const SENDKEY_PS1 = path.join(os.tmpdir(), "cs2-chat-translator-sendkey.ps1");
let sendKeyScriptReady = false;

function rememberSentMessage(message) {
  const key = String(message || "").trim().toLowerCase();
  if (!key) return;
  recentlySentMessages.set(key, Date.now() + 12000);
  // Opportunistic cleanup
  if (recentlySentMessages.size > 40) {
    const now = Date.now();
    for (const [k, exp] of recentlySentMessages) {
      if (exp < now) recentlySentMessages.delete(k);
    }
  }
}

function wasRecentlySent(message) {
  const key = String(message || "").trim().toLowerCase();
  const exp = recentlySentMessages.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    recentlySentMessages.delete(key);
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureSendKeyScript() {
  if (sendKeyScriptReady && fs.existsSync(SENDKEY_PS1)) return;
  const script = `
param([Parameter(Mandatory=$true)][string]$Key)
$ErrorActionPreference = 'SilentlyContinue'
try {
  if (-not ("Cs2Focus" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cs2Focus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
  }
} catch {}
$p = Get-Process -Name 'cs2' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
  Select-Object -First 1
if (-not $p) {
  $p = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -match 'Counter-Strike' -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
}
if ($p) {
  $h = $p.MainWindowHandle
  if ([Cs2Focus]::IsIconic($h)) { [void][Cs2Focus]::ShowWindowAsync($h, 9) }
  $fg = [Cs2Focus]::GetForegroundWindow()
  $pidFg = 0; $pidCs = 0
  $tFg = [Cs2Focus]::GetWindowThreadProcessId($fg, [ref]$pidFg)
  $tCs = [Cs2Focus]::GetWindowThreadProcessId($h, [ref]$pidCs)
  $tMe = [Cs2Focus]::GetCurrentThreadId()
  if ($tFg -ne $tCs) {
    [void][Cs2Focus]::AttachThreadInput($tMe, $tFg, $true)
    [void][Cs2Focus]::AttachThreadInput($tMe, $tCs, $true)
  }
  [void][Cs2Focus]::SetForegroundWindow($h)
  if ($tFg -ne $tCs) {
    [void][Cs2Focus]::AttachThreadInput($tMe, $tFg, $false)
    [void][Cs2Focus]::AttachThreadInput($tMe, $tCs, $false)
  }
  Start-Sleep -Milliseconds 60
}
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys($Key)
`;
  fs.writeFileSync(SENDKEY_PS1, script, "utf8");
  sendKeyScriptReady = true;
}

function pressBindKeyAsync() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      try {
        ensureSendKeyScript();
        const key = String(BIND_KEY || "l");
        const child = execChild(
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SENDKEY_PS1}" -Key "${key.replace(/"/g, '')}"`,
          { windowsHide: true, timeout: 4000 },
          (err) => {
            if (err) {
              log(sym.warn, chalk.yellow(`SendKey error: ${err.message}`));
              broadcast("error", { message: `SendKey error: ${err.message}` });
            }
            lastChatSendAt = Date.now();
            resolve(!err);
          }
        );
        // Safety: never hang the queue forever
        setTimeout(() => {
          try { child.kill(); } catch { /* noop */ }
        }, 4500);
      } catch (err) {
        log(sym.warn, chalk.yellow(`SendKey setup error: ${err.message}`));
        resolve(false);
      }
    } else {
      execChild(`xdotool key ${BIND_KEY}`, (err) => {
        if (err) {
          log(sym.warn, chalk.yellow(`xdotool error: ${err.message}`));
          broadcast("error", { message: `xdotool error: ${err.message}` });
        }
        lastChatSendAt = Date.now();
        resolve(!err);
      });
    }
  });
}

/**
 * Queue a CS2 chat send. Dedupes, caps backlog, single keypress per job.
 * @param {string} message
 * @param {{ team?: boolean, delayMs?: number, priority?: number }} [opts]
 *   priority: 2 = commands / your outgoing, 1 = incoming relay (dropped first under load)
 */
function sendToCs2Chat(message, { team = false, delayMs = CHAT_SETTLE_MS, priority = 1 } = {}) {
  if (!message) return false;
  const text = String(message).trim();
  if (!text) return false;

  // Already queued or just sent — skip (stops double-fire from race/retry).
  if (wasRecentlySent(text)) return false;
  if (chatSendQueue.some((j) => j.message.toLowerCase() === text.toLowerCase())) {
    return false;
  }

  // Under load: drop oldest low-priority jobs so we stay caught up.
  while (chatSendQueue.length >= MAX_CHAT_QUEUE) {
    const dropIdx = chatSendQueue.findIndex((j) => (j.priority ?? 1) <= 1);
    if (dropIdx >= 0) {
      const dropped = chatSendQueue.splice(dropIdx, 1)[0];
      log(sym.warn, chalk.yellow(`Queue full — dropped relay: ${dropped.message.slice(0, 48)}`));
    } else {
      chatSendQueue.shift();
    }
  }

  chatSendQueue.push({ message: text, team, delayMs, priority });
  chatSendQueue.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
  void pumpChatSendQueue();
  return true;
}

async function pumpChatSendQueue() {
  if (chatSendBusy) return;
  chatSendBusy = true;
  try {
    while (chatSendQueue.length) {
      const job = chatSendQueue.shift();
      if (!writeChatCfg({ message: job.message, team: job.team })) continue;

      // Mark before press so the console.log echo of our say is ignored.
      rememberSentMessage(job.message);

      const sinceLast = Date.now() - (lastChatSendAt || 0);
      const settle = sinceLast < 900
        ? Math.min(job.delayMs ?? CHAT_SETTLE_MS, 220)
        : (job.delayMs ?? CHAT_SETTLE_MS);
      await sleep(settle);

      const ok = await pressBindKeyAsync();
      if (!ok && !job._retried) {
        log(sym.warn, chalk.yellow("SendKey missed — retrying once (or press L manually)"));
        chatSendQueue.unshift({ ...job, _retried: true, priority: Math.max(job.priority ?? 1, 2) });
        await sleep(300);
        continue;
      }
      await sleep(CHAT_GAP_MS);
    }
  } finally {
    chatSendBusy = false;
    if (chatSendQueue.length) void pumpChatSendQueue();
  }
}

// Legacy sync wrapper (unused by queue, kept for safety)
function pressBindKey() {
  void pressBindKeyAsync();
}

function langName(iso) {
  const key = (iso || "").toLowerCase();
  return LANG_MAP[key] || key.toUpperCase() || "UNKNOWN";
}

// -----------------------------------------------------------------------------
// Translation logic
// -----------------------------------------------------------------------------

async function smartTranslate(text, toLang = "en") {
  try {
    let res = await translate(text, { to: toLang });
    const guess = (res.from?.language?.iso || "").toLowerCase();
    const shouldForceRu =
      PREFER_RU_FOR_CYRILLIC && CYRILLIC_REGEX.test(text) && guess !== "ru";
    if (shouldForceRu) {
      try {
        const forced = await translate(text, { from: "ru", to: toLang });
        forced.__forcedFrom = "ru";
        return forced;
      } catch { /* fall through */ }
    }
    return res;
  } catch (err) {
    log(sym.warn, chalk.yellow(`Translation failed: ${err.message}`));
    broadcast("error", { message: `Translation failed: ${err.message}` });
    return { text, from: { language: { iso: "unknown" } } };
  }
}

function originalLangReadable(res) {
  const iso = (res.__forcedFrom || res.from?.language?.iso || "unknown").toLowerCase();
  return langName(iso);
}

// -----------------------------------------------------------------------------
// code_<language name> command
// -----------------------------------------------------------------------------

function normalizeQueryLoose(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLangCandidates() {
  return Object.entries(LANG_MAP).map(([code, name]) => {
    const bare = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
    const aliases = new Set([
      name.toLowerCase(),
      bare.toLowerCase(),
      code.toLowerCase()
    ]);
    if (code === "zh_cn") { aliases.add("simplified chinese"); aliases.add("chinese simplified"); }
    if (code === "zh_tw") { aliases.add("traditional chinese"); aliases.add("chinese traditional"); }
    if (code === "ga")    { aliases.add("irish gaelic"); }
    if (code === "gd")    { aliases.add("scottish gaelic"); aliases.add("scots gaelic"); }
    if (code === "jw")    { aliases.add("javanese"); }
    if (code === "my")    { aliases.add("burmese"); }
    if (code === "tl")    { aliases.add("tagalog"); }
    if (code === "pt")    { aliases.add("brazilian portuguese"); aliases.add("brasilianisch"); }
    if (code === "he")    { aliases.add("ivrit"); }
    return { code, name, aliases: Array.from(aliases) };
  });
}

function bestLangMatch(query) {
  const q = normalizeQueryLoose(query);
  if (!q) return null;
  const candidates = buildLangCandidates();
  for (const c of candidates) {
    if (c.aliases.some((a) => a === q)) return { code: c.code, name: c.name, score: 100 };
  }
  let best = null;
  for (const c of candidates) {
    const score = Math.max(...c.aliases.map((a) => fuzz.ratio(q, a)));
    if (!best || score > best.score) best = { code: c.code, name: c.name, score };
  }
  return best && best.score >= 55 ? best : null;
}

function handleCodeLang({ isTeam, message }) {
  const m = message.match(/^code[_\s]+(.+)$/i);
  if (!m) return false;
  const query = m[1].trim();
  if (!query) return true;

  const match = bestLangMatch(query);
  if (match) {
    const reply = `For ${match.name} use tm_${match.code}`;
    sendToCs2Chat(reply, { team: isTeam, priority: 2 });
    log(sym.info, chalk.cyan(`code → ${reply} (score ${match.score})`));
    broadcast("command", { kind: "code", query, reply, score: match.score });
  } else {
    const reply =
      `No close language match for "${query}". Try tm_en, tm_de, tm_fr, tm_es, tm_ru, tm_pt...`;
    sendToCs2Chat(reply, { team: isTeam, priority: 2 });
    log(sym.warn, chalk.yellow(reply));
    broadcast("command", { kind: "code", query, reply, score: 0 });
  }
  return true;
}

// -----------------------------------------------------------------------------
// Commands: tm_ and _tl
// -----------------------------------------------------------------------------

let lastForeignMsg = null;

async function handleTm({ isTeam, sender, message }) {
  if (!/^tm_[a-z_]{2,5}\b/i.test(message)) return false;
  const [cmd, ...rest] = message.split(" ");
  const lang = cmd.slice(3).toLowerCase();
  const text = rest.join(" ").trim();
  if (!text) return true;

  const res = await smartTranslate(text, lang);
  const translated = res.text;
  const originalLang = originalLangReadable(res);

  const output = `${sender} said - ${translated} - (from ${originalLang})`;
  sendToCs2Chat(output, { team: isTeam, priority: 2 });

  log(sym.trans, chalk.blueBright(`tm_${lang} → sent to chat`));
  logKV("from", originalLang);
  logKV("text", translated);
  broadcast("command", {
    kind: "tm", target: lang, from: originalLang,
    sender, original: text, translated
  });
  return true;
}

async function handleTl({ isTeam, message }) {
  if (!/^_tl\b/i.test(message)) return false;

  if (!lastForeignMsg) {
    const msg = "No recent message to translate.";
    sendToCs2Chat(msg, { team: isTeam, priority: 2 });
    log(sym.warn, chalk.yellow(msg));
    broadcast("command", { kind: "tl", status: "no-last", reply: msg });
    return true;
  }

  const parts = message.split(" ");
  const target = parts[1]?.toLowerCase() || AUTO_TRANSLATE_TARGET;

  const res = await smartTranslate(lastForeignMsg.message, target);
  const translated = res.text;
  const originalLang = originalLangReadable(res);
  const output = `${lastForeignMsg.player} said - ${translated} - (from ${originalLang})`;

  sendToCs2Chat(output, { team: isTeam, priority: 2 });

  log(sym.trans, chalk.blueBright(`_tl → ${target}`));
  logKV("from", originalLang);
  logKV("player", lastForeignMsg.player);
  logKV("text", translated);
  broadcast("command", {
    kind: "tl", target, from: originalLang,
    sender: lastForeignMsg.player, original: lastForeignMsg.message, translated
  });
  return true;
}

async function handleMyTranslation({ isTeam, sender, message }) {
  if (!/^t_[a-z_]{2,5}\b/i.test(message)) return false;
  const [cmd, ...rest] = message.split(" ");
  const lang = cmd.slice(2).toLowerCase();
  const text = rest.join(" ").trim();
  if (!text) return true;

  const res = await smartTranslate(text, lang);
  const translated = res.text;

  sendToCs2Chat(translated, { team: isTeam, priority: 2 });

  log(sym.trans, chalk.green(`t_${lang} → auto-sent raw: ${translated}`));
  broadcast("command", {
    kind: "my_trans", target: lang,
    original: text, translated
  });
  
  return true;
}

// -----------------------------------------------------------------------------
// Auto-translate to console (+ optional relay into CS2 chat)
// -----------------------------------------------------------------------------

async function autoTranslateToConsole({ team, sender, message, isTeam }) {
  if (!AUTO_TRANSLATE) return;
  if (!message) return;
  if (/^(_tl\b|tm_[a-z_]{2,5}\b|t_[a-z_]{2,5}\b|code[_\s])/i.test(message)) return;
  if (/^[.\s]+$/.test(message)) return;

  // --- Loop breakers ---
  // 1) Already looks like a translator / relay line → never re-translate.
  if (looksLikeTranslatedOutput(message)) return;
  // 2) Exact echo of something we just sent via bind.
  if (wasRecentlySent(message)) return;

  const mine = isMyMessage(sender);

  // Your messages → translate to outgoingTarget and show in console only (copy/paste yourself).
  if (mine && TRANSLATE_OUTGOING && OUTGOING_TARGET) {
    const res = await smartTranslate(message, OUTGOING_TARGET);
    const fromIso = (res.__forcedFrom || res.from?.language?.iso || "unknown").toLowerCase();
    if (fromIso !== OUTGOING_TARGET.toLowerCase() && res.text && res.text.trim() !== message.trim()) {
      const out = res.text.trim();
      console.log(
        sym.trans,
        chalk.green(`[YOU → ${OUTGOING_TARGET.toUpperCase()}] `) + chalk.white(out)
      );
      broadcast("auto", {
        team, sender, mine: true,
        fromIso, fromName: langName(fromIso),
        target: OUTGOING_TARGET,
        translated: out,
        original: message
      });
      // Never auto-send to CS2 — user copies from console/GUI.
    }
    return;
  }

  // Own username: never treat as incoming foreign chat.
  if (mine) return;

  const res = await smartTranslate(message, AUTO_TRANSLATE_TARGET);
  const fromIso = (res.__forcedFrom || res.from?.language?.iso || "unknown").toLowerCase();

  if (fromIso !== AUTO_TRANSLATE_TARGET.toLowerCase()) {
    const readableLang = langName(fromIso);
    console.log(
      sym.trans,
      chalk.blueBright(
        `[${team}] ${sender} (${readableLang} → ${AUTO_TRANSLATE_TARGET.toUpperCase()}): `
      ) + chalk.gray(res.text)
    );
    broadcast("auto", {
      team, sender,
      fromIso, fromName: readableLang,
      target: AUTO_TRANSLATE_TARGET,
      translated: res.text,
      original: message
    });

    // Optional: only if user explicitly enables relayToChat in GUI/config.
    if (RELAY_TO_CHAT && res.text) {
      const cleanSender = normalizePlayerName(sender) || sender;
      const tag = AUTO_TRANSLATE_TARGET.toUpperCase();
      const relay = `[${tag}] ${cleanSender}: ${res.text}`;
      sendToCs2Chat(relay, { team: false, delayMs: 380, priority: 1 });
    }
  }
}

// -----------------------------------------------------------------------------
// Voice translate (WASAPI loopback → Whisper → Google Translate → console)
// -----------------------------------------------------------------------------

async function handleVoiceSpeech({ text, lang }) {
  if (!text) return;
  if (looksLikeTranslatedOutput(text)) return;
  const target = AUTO_TRANSLATE_TARGET || "tr";
  const res = await smartTranslate(text, target);
  const fromIso = (res.__forcedFrom || lang || res.from?.language?.iso || "unknown").toLowerCase();
  const translated = res.text || text;

  console.log(
    chalk.magenta("🎤"),
    chalk.magentaBright(`[VOICE] `) +
      chalk.gray(`(${langName(fromIso)} → ${target.toUpperCase()}) `) +
      chalk.white(text) +
      (fromIso !== target.toLowerCase() && translated !== text
        ? chalk.green(`  ⇒  ${translated}`)
        : "")
  );
  broadcast("voice", {
    original: text,
    translated,
    fromIso,
    fromName: langName(fromIso),
    target
  });
}

function startVoiceTranslate() {
  if (voiceHandle) {
    try { voiceHandle.stop(); } catch { /* noop */ }
    voiceHandle = null;
  }
  if (!voicePythonPath()) {
    log(
      sym.warn,
      chalk.yellow(
        "Voice: .venv-voice yok. Kurulum: py -3.11 -m venv .venv-voice && .venv-voice\\Scripts\\pip install -r requirements-voice.txt"
      )
    );
    return;
  }
  log(sym.info, chalk.cyan("Voice translate starting (WASAPI loopback → Whisper)…"));
  voiceHandle = startVoiceWorker({
    model: VOICE_MODEL,
    chunk: VOICE_CHUNK,
    device: VOICE_DEVICE,
    energy: 35,
    debug: process.env.CS2_VOICE_DEBUG === "1",
    onLog: (line) => console.log(chalk.gray(line)),
    onEvent: (evt) => {
      if (!evt || !evt.type) return;
      if (evt.type === "ready") {
        log(
          sym.ok,
          chalk.green(
            `Voice ready — device: ${evt.device} | model: ${evt.model} | chunk: ${evt.chunk}s | mode: ${evt.mode || "callback"}`
          )
        );
        broadcast("status", statusSnapshot({ voiceReady: true, voiceDeviceLive: evt.device }));
      } else if (evt.type === "speech") {
        Promise.resolve(handleVoiceSpeech(evt)).catch((err) => {
          console.error(chalk.red("Voice translate error:"), err);
        });
      } else if (evt.type === "status") {
        log(sym.info, chalk.gray(`[voice] ${evt.message}`));
      } else if (evt.type === "error") {
        log(sym.err, chalk.red(`[voice] ${evt.message}`));
        broadcast("error", { message: `voice: ${evt.message}` });
      }
    }
  });
}

// -----------------------------------------------------------------------------
// Log line parsing
// -----------------------------------------------------------------------------

async function handleLine(line) {
  if (!TAG_REGEX) return;
  const match = line.match(TAG_REGEX);
  if (!match) return;

  const [, matchedTag, player, messageRaw] = match;

  // Normalize the matched (possibly localized) tag to canonical CT / T / ALL
  // so downstream styling, tm_/_tl logic, and the UI stay language-agnostic.
  const team = canonicalizeTeam(matchedTag);

  const message = (messageRaw || "").trim();
  const sender = (player || "").trim();
  const isTeam = team === "CT" || team === "T";

  log(
    sym.chat,
    chalk.magentaBright(`[${team}] `) +
      chalk.bold(sender) +
      chalk.white(": ") +
      chalk.white(message)
  );
  broadcast("chat", { team, sender, message, rawTag: matchedTag });

  if (
    !/^tm_[a-z_]{2,5}\b|^_tl\b|^code[_\s]|^t_[a-z_]{2,5}\b/i.test(message) &&
    !/^[.\s]+$/.test(message) &&
    !looksLikeTranslatedOutput(message) &&
    !isMyMessage(sender)
  ) {
    lastForeignMsg = { player: sender, message, team };
  }

  if (await handleTl({ isTeam, message })) return;
  if (handleCodeLang({ isTeam, message })) return;
  if (await handleTm({ isTeam, sender, message })) return;
  if (await handleMyTranslation({ isTeam, sender, message })) return;

  await autoTranslateToConsole({ team, sender, message, isTeam });
}

// -----------------------------------------------------------------------------
// File watcher (extracted so the GUI can restart it after a config change)
// -----------------------------------------------------------------------------

let currentlyWatching = null;
let logReadOffset = 0;
let healthCheckTimer = null;

function stopWatching() {
  if (currentlyWatching) {
    fs.unwatchFile(currentlyWatching);
    currentlyWatching = null;
  }
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  logReadOffset = 0;
}

function diagnoseLogFile() {
  if (!LOG_PATH) {
    return { logExists: false, logSize: 0, warning: "logPath is not configured." };
  }
  if (!fs.existsSync(LOG_PATH)) {
    return {
      logExists: false,
      logSize: 0,
      warning: `console.log not found: ${LOG_PATH}. Start CS2 once with -condebug so the file is created.`
    };
  }
  let logSize = 0;
  let mtimeMs = 0;
  try {
    const st = fs.statSync(LOG_PATH);
    logSize = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { logExists: false, logSize: 0, warning: `Cannot read console.log: ${LOG_PATH}` };
  }
  if (logSize === 0) {
    return {
      logExists: true,
      logSize: 0,
      mtimeMs,
      warning:
        "console.log is empty (0 bytes). Add -condebug to CS2 Steam launch options, fully restart CS2, then press Restart watcher. Tip: run with --ensure-condebug"
    };
  }
  return { logExists: true, logSize, mtimeMs, warning: null };
}

function readNewLogBytes(from, to) {
  if (to <= from) return;
  const stream = fs.createReadStream(LOG_PATH, {
    start: from,
    end: to - 1,
    encoding: "utf8"
  });
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    Promise.resolve(handleLine(line)).catch((err) => {
      console.error(chalk.red("Line handling error:"), err);
      broadcast("error", { message: `Line handling: ${err.message}` });
    });
  });
}

function startWatching() {
  stopWatching();
  if (!fs.existsSync(LOG_PATH)) {
    console.error(chalk.red(`❌ console.log not found: ${LOG_PATH}`));
    broadcast("status", statusSnapshot({
      watching: false,
      error: `console.log not found: ${LOG_PATH}`
    }));
    return false;
  }
  if (!fs.existsSync(CSGO_CFG_DIR)) {
    console.error(chalk.red(`❌ cfg directory not found: ${CSGO_CFG_DIR}`));
    broadcast("status", statusSnapshot({
      watching: false,
      error: `cfg directory not found: ${CSGO_CFG_DIR}`
    }));
    return false;
  }

  currentlyWatching = LOG_PATH;
  try {
    // Start at EOF so we only process new chat after the tool starts.
    // Truncation / recreate is handled below via offset reset.
    logReadOffset = fs.statSync(LOG_PATH).size;
  } catch {
    logReadOffset = 0;
  }

  fs.watchFile(LOG_PATH, { interval: 400 }, (curr) => {
    try {
      // File was truncated or replaced (common on CS2 restart with -conclearlog).
      if (curr.size < logReadOffset) {
        logReadOffset = 0;
        broadcast("status", statusSnapshot({ watching: true }));
      }
      if (curr.size > logReadOffset) {
        const from = logReadOffset;
        const wasEmpty = from === 0;
        logReadOffset = curr.size;
        readNewLogBytes(from, curr.size);
        if (wasEmpty) broadcast("status", statusSnapshot({ watching: true }));
      }
    } catch (err) {
      console.error(chalk.red(`Watch error: ${err.message}`));
      broadcast("error", { message: `Watch error: ${err.message}` });
    }
  });

  // Periodic health ping so the UI doesn't stay stuck on a stale "waiting" state.
  healthCheckTimer = setInterval(() => {
    if (!currentlyWatching) return;
    broadcast("status", statusSnapshot({ watching: true }));
  }, 5000);

  const snap = statusSnapshot({ watching: true });
  if (snap.warning) {
    log(sym.warn, chalk.yellow(snap.warning));
  } else {
    log(sym.ok, chalk.green(`Watching ${LOG_PATH}`));
  }
  broadcast("status", snap);
  return true;
}

function statusSnapshot(overrides = {}) {
  const diag = diagnoseLogFile();
  return {
    watching: !!currentlyWatching,
    logPath: LOG_PATH,
    cfgDir: CSGO_CFG_DIR,
    bindKey: BIND_KEY,
    autoTranslate: AUTO_TRANSLATE,
    autoTranslateTarget: AUTO_TRANSLATE_TARGET,
    relayToChat: RELAY_TO_CHAT,
    myName: MY_NAME,
    outgoingTarget: OUTGOING_TARGET,
    translateOutgoing: TRANSLATE_OUTGOING,
    voiceEnabled: VOICE_ENABLED,
    voiceModel: VOICE_MODEL,
    voiceChunkSec: VOICE_CHUNK,
    voiceDevice: VOICE_DEVICE,
    voicePython: !!voicePythonPath(),
    tagCT: TAG_CT,
    tagT: TAG_T,
    tagAll: TAG_ALL,
    logExists: diag.logExists,
    logSize: diag.logSize,
    cfgDirExists: CSGO_CFG_DIR ? fs.existsSync(CSGO_CFG_DIR) : false,
    chatCfgExists: CHAT_CFG ? fs.existsSync(CHAT_CFG) : false,
    configPath: CONFIG_PATH,
    warning: diag.warning,
    ...overrides
  };
}

// -----------------------------------------------------------------------------
// HTTP server (web GUI)
// -----------------------------------------------------------------------------

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="dark" data-size="md">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CS2 Sesli Translator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&family=Inter:wght@400;500&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    /* Theme-tokens (dark defaults; light overrides below) */
    --bg: #0b0b0c;
    --surface: #141416;
    --surface-2: #1c1c1f;
    --border: #26262a;
    --border-strong: #3a3a40;
    --text: #e8e8ea;
    --muted: #7d7d84;
    --muted-2: #55555b;
    --good: #65b881;
    --bad: #d46464;
    --info: #7ab0d9;
    --warm: #d99464;

    /* User-customizable accent + font */
    --accent: #d9a84b;
    --accent-dim: #77602a;
    --accent-ink: #1a1205; /* text color on an accent button */
    --font: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --base-size: 13px;
  }
  html[data-theme="light"] {
    --bg: #fafaf7;
    --surface: #ffffff;
    --surface-2: #f1f1ec;
    --border: #e3e3dc;
    --border-strong: #c4c4ba;
    --text: #1a1a1c;
    --muted: #6a6a6e;
    --muted-2: #a5a5a9;
    --good: #2f8a4e;
    --bad: #c24040;
    --info: #3d82b8;
    --warm: #b4682f;
    --accent-ink: #1a1205;
  }
  html[data-size="sm"] { --base-size: 12px; }
  html[data-size="md"] { --base-size: 13px; }
  html[data-size="lg"] { --base-size: 14.5px; }

  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font-family: var(--font); font-size: var(--base-size); line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  body {
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: 1fr;
    min-height: 100vh;
  }

  /* Header */
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    gap: 16px;
  }
  .brand { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
  .brand .mark {
    color: var(--accent); font-weight: 600; letter-spacing: -0.01em;
  }
  .brand .name {
    color: var(--text); font-weight: 500; letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .brand .tag {
    color: var(--muted); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .header-right { display: flex; align-items: center; gap: 14px; }
  .status { display: flex; align-items: center; gap: 10px; font-size: 12px; }
  .status .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--muted-2);
    box-shadow: 0 0 0 0 rgba(101,184,129,0);
  }
  .status.on .dot {
    background: var(--good);
    animation: pulse 2s ease-in-out infinite;
  }
  .status.bad .dot { background: var(--bad); }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(101,184,129,0.35); }
    50%      { box-shadow: 0 0 0 6px rgba(101,184,129,0); }
  }
  .status .label { color: var(--muted); }
  .status.on .label { color: var(--text); }
  .status.bad .label { color: var(--bad); }

  .icon-btn {
    width: 30px; height: 30px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    padding: 0;
    transition: border-color 120ms, color 120ms;
  }
  .icon-btn:hover { border-color: var(--border-strong); color: var(--text); }
  .icon-btn svg { width: 14px; height: 14px; display: block; }

  /* Main layout — flex so sidebar can collapse smoothly */
  main {
    display: flex;
    min-height: 0;
    overflow: hidden;
    align-items: stretch;
  }
  .feed {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 16px 24px 32px;
    scroll-behavior: smooth;
  }
  aside {
    flex: 0 0 360px;
    width: 360px;
    overflow-y: auto;
    padding: 20px 20px 32px;
    border-left: 1px solid var(--border);
    background: var(--surface);
    transition: flex-basis 220ms ease, width 220ms ease, padding 220ms ease, border-left-color 220ms ease;
  }
  main.aside-hidden aside {
    flex: 0 0 0;
    width: 0;
    padding-left: 0;
    padding-right: 0;
    border-left-color: transparent;
    overflow: hidden;
  }
  @media (max-width: 900px) {
    main { flex-direction: column; }
    aside { flex: 0 0 auto; width: 100%; max-height: 55vh; border-left: 0; border-top: 1px solid var(--border); }
    main.aside-hidden aside { flex: 0 0 0; max-height: 0; padding-top: 0; padding-bottom: 0; border-top-color: transparent; }
  }

  /* Scrollbars */
  .feed::-webkit-scrollbar, aside::-webkit-scrollbar { width: 10px; }
  .feed::-webkit-scrollbar-track, aside::-webkit-scrollbar-track { background: transparent; }
  .feed::-webkit-scrollbar-thumb {
    background: var(--border); border-radius: 10px; border: 2px solid var(--bg);
  }
  aside::-webkit-scrollbar-thumb {
    background: var(--border-strong); border-radius: 10px; border: 2px solid var(--surface);
  }

  /* Feed entries */
  .feed-empty {
    color: var(--muted); text-align: center;
    padding: 64px 16px; font-style: italic;
  }
  .feed-empty .hint {
    display: block; margin-top: 8px; font-style: normal;
    color: var(--muted-2); font-size: 11px;
  }
  .entry {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid transparent;
    animation: slide-in 160ms ease-out;
  }
  .entry + .entry { border-top: 1px dashed var(--border); }
  @keyframes slide-in {
    from { opacity: 0; transform: translateY(2px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .entry .meta {
    color: var(--muted-2); font-size: 11px; padding-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .entry .body { min-width: 0; }
  .entry .body .line { word-wrap: break-word; word-break: break-word; }

  .tag {
    display: inline-block; padding: 1px 6px;
    font-size: 10px; letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 2px; margin-right: 6px;
    vertical-align: 1px;
    border: 1px solid var(--border-strong);
    color: var(--muted);
  }
  .tag.ct  { color: var(--info);  border-color: color-mix(in srgb, var(--info) 40%, transparent); }
  .tag.t   { color: var(--warm);  border-color: color-mix(in srgb, var(--warm) 40%, transparent); }
  .tag.all { color: var(--muted); border-color: var(--border-strong); }

  .sender { color: var(--text); font-weight: 500; }
  .msg    { color: color-mix(in srgb, var(--text) 75%, transparent); }

  .translation {
    margin-top: 4px; padding-left: 12px;
    border-left: 2px solid var(--accent-dim);
    color: var(--muted);
  }
  .translation .arrow { color: var(--accent); padding: 0 4px; }
  .translation .lang { color: var(--accent); }
  .translation .translated { color: var(--text); }

  .entry.system .body .line { color: var(--muted); font-style: italic; }
  .entry.error  .body .line { color: var(--bad); }
  .entry.command .body .line { color: var(--text); }
  .entry.command .kind {
    display: inline-block; color: var(--accent); font-weight: 500;
    margin-right: 6px;
  }

  /* Sidebar sections */
  .section { margin-bottom: 28px; }
  .section h2 {
    margin: 0 0 12px 0;
    font-size: 11px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--muted);
  }
  .subhead {
    margin: 18px 0 10px;
    font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--muted-2);
  }

  .field { margin-bottom: 12px; }
  .field label {
    display: block; margin-bottom: 4px;
    font-size: 11px; color: var(--muted);
  }
  .field input[type="text"], .field select {
    width: 100%; padding: 8px 10px;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: var(--font); font-size: 12px;
    outline: none; transition: border-color 120ms;
    appearance: none;
  }
  .field select {
    background-image:
      linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 14px) 50%, calc(100% - 10px) 50%;
    background-size: 4px 4px, 4px 4px;
    background-repeat: no-repeat;
    padding-right: 26px;
  }
  .field input[type="text"]:focus, .field select:focus {
    border-color: var(--accent-dim);
  }
  .field .row-3 {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
  }
  .field .row-2 {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .field .hint {
    color: var(--muted-2); font-size: 10px; margin-top: 4px; line-height: 1.5;
  }

  .toggle {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .toggle .label { font-size: 12px; color: var(--text); }
  .switch {
    position: relative; width: 32px; height: 18px;
    background: var(--border-strong); border-radius: 10px;
    cursor: pointer; transition: background 120ms;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%;
    background: var(--muted); transition: all 120ms;
  }
  .switch.on { background: var(--accent-dim); }
  .switch.on::after { left: 16px; background: var(--accent); }

  /* Segmented (theme/size) */
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    width: 100%;
  }
  .seg button {
    flex: 1; padding: 7px 0;
    background: var(--bg); color: var(--muted);
    border: 0; border-left: 1px solid var(--border);
    border-radius: 0;
    font-family: var(--font); font-size: 11px;
    cursor: pointer; transition: background 120ms, color 120ms;
  }
  .seg button:first-child { border-left: 0; }
  .seg button:hover { color: var(--text); }
  .seg button.active {
    background: var(--surface-2); color: var(--accent);
  }

  /* Swatches (accent presets) */
  .swatches { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .swatch {
    width: 22px; height: 22px; border-radius: 50%;
    cursor: pointer; border: 2px solid transparent;
    transition: transform 120ms, border-color 120ms;
    position: relative;
  }
  .swatch:hover { transform: scale(1.08); }
  .swatch.active { border-color: var(--text); }
  .swatch-custom {
    display: inline-flex; align-items: center; gap: 6px;
    margin-left: auto; font-size: 11px; color: var(--muted);
  }
  input[type="color"] {
    width: 26px; height: 22px; padding: 0; cursor: pointer;
    background: transparent; border: 1px solid var(--border);
    border-radius: 3px;
  }
  input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
  input[type="color"]::-webkit-color-swatch { border: 0; border-radius: 2px; }

  .actions { display: flex; gap: 8px; margin-top: 14px; }
  button.btn {
    padding: 8px 14px;
    background: transparent; color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    font-family: var(--font); font-size: 12px;
    cursor: pointer; transition: all 120ms;
  }
  button.btn:hover:not(:disabled) {
    border-color: var(--accent-dim); color: var(--accent);
  }
  button.btn.primary {
    background: var(--accent); color: var(--accent-ink);
    border-color: var(--accent); font-weight: 500;
  }
  button.btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, white);
  }
  button.btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .toast {
    margin-top: 10px; min-height: 16px;
    font-size: 11px; color: var(--muted);
  }
  .toast.ok { color: var(--good); }
  .toast.err { color: var(--bad); }

  /* Command reference */
  .cmds .cmd { padding: 10px 0; border-top: 1px solid var(--border); }
  .cmds .cmd:first-child { border-top: 0; }
  .cmds .cmd code { color: var(--accent); font-weight: 500; }
  .cmds .cmd p {
    margin: 4px 0 0 0;
    color: var(--muted); font-size: 11px; line-height: 1.5;
  }
  .cmds .cmd .ex {
    color: var(--muted-2); font-size: 11px; margin-top: 2px;
  }
  .cmds .cmd .ex span { color: var(--muted); }

  .path-hint {
    color: var(--muted-2); font-size: 10px; margin-top: 6px;
    word-break: break-all;
  }

  .warn-banner {
    margin-bottom: 18px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent);
    border-radius: 3px;
    color: var(--bad); font-size: 11px;
  }
  .warn-banner.hidden { display: none; }
</style>
</head>
<body>

<header>
  <div class="brand">
    <span class="mark">CS2</span>
    <span class="name">Sesli&nbsp;Translator</span>
    <span class="tag">Canlı</span>
  </div>
  <div class="header-right">
    <div class="status off" id="status">
      <span class="dot"></span>
      <span class="label" id="statusLabel">connecting…</span>
    </div>
    <button class="icon-btn" id="asideToggle" aria-label="Toggle sidebar" aria-expanded="true" title="Toggle sidebar (Ctrl+B)">
      <!-- sidebar toggle icon -->
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
        <line x1="10" y1="2.5" x2="10" y2="13.5"/>
      </svg>
    </button>
  </div>
</header>

<main id="main">
  <section class="feed" id="feed">
    <div class="feed-empty" id="feedEmpty">
      waiting for chat…
      <span class="hint" id="feedHint">make sure CS2 is running with -condebug and console logging is writing to console.log</span>
    </div>
  </section>

  <aside id="aside">
    <div class="warn-banner hidden" id="warnBanner"></div>

    <div class="section">
      <h2>Configuration</h2>
      <div class="field">
        <label for="logPath">Console log</label>
        <input id="logPath" type="text" spellcheck="false" />
      </div>
      <div class="field">
        <label for="cfgDir">CFG directory</label>
        <input id="cfgDir" type="text" spellcheck="false" />
      </div>
      <div class="field">
        <div class="row-2">
          <div>
            <label for="bindKey">Bind key</label>
            <input id="bindKey" type="text" spellcheck="false" maxlength="16" />
          </div>
          <div>
            <label for="autoTarget">Target</label>
            <input id="autoTarget" type="text" spellcheck="false" maxlength="6" />
          </div>
        </div>
      </div>

      <div class="subhead">Chat tag prefixes</div>
      <div class="field">
        <div class="row-3">
          <div>
            <label for="tagCT">CT team</label>
            <input id="tagCT" type="text" spellcheck="false" maxlength="16" />
          </div>
          <div>
            <label for="tagT">T team</label>
            <input id="tagT" type="text" spellcheck="false" maxlength="16" />
          </div>
          <div>
            <label for="tagAll">All-chat</label>
            <input id="tagAll" type="text" spellcheck="false" maxlength="16" />
          </div>
        </div>
        <div class="hint">CS2 writes a bracketed tag before each chat line (e.g. <code>[CT]</code>). Override if your client is in another language.</div>
      </div>

      <div class="field" style="margin-top:14px;">
        <label>Auto-translate non-commands</label>
        <div class="toggle">
          <span class="label">Show auto-translations in feed</span>
          <div class="switch" id="autoSwitch" role="button" tabindex="0" aria-label="Toggle auto-translate"></div>
        </div>
      </div>

      <div class="field" style="margin-top:10px;">
        <label>Relay into CS2 chat</label>
        <div class="toggle">
          <span class="label">Auto-say translations in-game (spammy — keep off)</span>
          <div class="switch" id="relaySwitch" role="button" tabindex="0" aria-label="Toggle relay to chat"></div>
        </div>
        <div class="hint">Off = console/GUI only. Copy the line and paste in CS2 yourself. Commands <code>t_en</code> / <code>tm_</code> still can send if you use them.</div>
      </div>

      <div class="field" style="margin-top:10px;">
        <div class="row-2">
          <div>
            <label for="myName">Your name</label>
            <input id="myName" type="text" spellcheck="false" placeholder="metehan12024" />
          </div>
          <div>
            <label for="outgoingTarget">Outgoing lang</label>
            <input id="outgoingTarget" type="text" spellcheck="false" maxlength="6" placeholder="en" />
          </div>
        </div>
        <div class="toggle" style="margin-top:8px;">
          <span class="label">Translate my chat → console (copy/paste)</span>
          <div class="switch" id="outSwitch" role="button" tabindex="0" aria-label="Toggle outgoing translate"></div>
        </div>
      </div>

      <div class="actions">
        <button class="btn primary" id="saveBtn">Save</button>
        <button class="btn" id="restartBtn">Restart watcher</button>
      </div>
      <div class="toast" id="toast"></div>
      <div class="path-hint" id="cfgPathHint"></div>
    </div>

    <div class="section">
      <h2>Appearance</h2>

      <div class="field">
        <label>Theme</label>
        <div class="seg" id="segTheme">
          <button data-val="dark" class="active">Dark</button>
          <button data-val="light">Light</button>
        </div>
      </div>

      <div class="field">
        <label>Accent</label>
        <div class="swatches" id="swatches">
          <div class="swatch" data-val="#d9a84b" style="background:#d9a84b" title="Amber"></div>
          <div class="swatch" data-val="#65b881" style="background:#65b881" title="Terminal"></div>
          <div class="swatch" data-val="#7dd3fc" style="background:#7dd3fc" title="Ice"></div>
          <div class="swatch" data-val="#e06666" style="background:#e06666" title="Crimson"></div>
          <div class="swatch" data-val="#c9b8ff" style="background:#c9b8ff" title="Lilac"></div>
          <div class="swatch" data-val="#e8e8ea" style="background:#e8e8ea" title="Mono"></div>
          <div class="swatch-custom">
            <span>custom</span>
            <input type="color" id="accentPicker" value="#d9a84b" aria-label="Custom accent color" />
          </div>
        </div>
      </div>

      <div class="field">
        <label for="fontSel">Font</label>
        <select id="fontSel">
          <option value='"JetBrains Mono", ui-monospace, monospace'>JetBrains Mono</option>
          <option value='"IBM Plex Mono", ui-monospace, monospace'>IBM Plex Mono</option>
          <option value='"Fira Code", ui-monospace, monospace'>Fira Code</option>
          <option value='"Space Mono", ui-monospace, monospace'>Space Mono</option>
          <option value='"IBM Plex Sans", ui-sans-serif, system-ui'>IBM Plex Sans</option>
          <option value='"Inter", ui-sans-serif, system-ui'>Inter</option>
        </select>
      </div>

      <div class="field">
        <label>Density</label>
        <div class="seg" id="segSize">
          <button data-val="sm">Small</button>
          <button data-val="md" class="active">Medium</button>
          <button data-val="lg">Large</button>
        </div>
      </div>

      <div class="actions">
        <button class="btn" id="resetAppearance">Reset appearance</button>
      </div>
    </div>

    <div class="section cmds">
      <h2>In-game commands</h2>
      <div class="cmd">
        <code>tm_&lt;lang&gt; TEXT</code>
        <p>Translate TEXT and send to chat.</p>
        <div class="ex"><span>e.g.</span> tm_de hello friend</div>
      </div>
      <div class="cmd">
        <code>t_&lt;lang&gt; TEXT</code>
        <p>Translate TEXT & auto-send raw translation.</p>
        <div class="ex"><span>e.g.</span> t_en hello friend</div>
      </div>
      <div class="cmd">
        <code>_tl [lang]</code>
        <p>Translate the previous non-command message (default: tr).</p>
        <div class="ex"><span>e.g.</span> _tl fr</div>
      </div>
      <div class="cmd">
        <code>code_&lt;language&gt;</code>
        <p>Fuzzy lookup: replies with the right <code>tm_&lt;code&gt;</code>.</p>
        <div class="ex"><span>e.g.</span> code_french → For French use tm_fr</div>
      </div>
    </div>
  </aside>
</main>

<script>
  const feedEl = document.getElementById('feed');
  const feedEmpty = document.getElementById('feedEmpty');
  const statusEl = document.getElementById('status');
  const statusLabel = document.getElementById('statusLabel');
  const warnBanner = document.getElementById('warnBanner');
  const toast = document.getElementById('toast');
  const cfgPathHint = document.getElementById('cfgPathHint');
  const mainEl = document.getElementById('main');
  const asideToggle = document.getElementById('asideToggle');

  const logPathInput = document.getElementById('logPath');
  const cfgDirInput  = document.getElementById('cfgDir');
  const bindKeyInput = document.getElementById('bindKey');
  const autoTargetInput = document.getElementById('autoTarget');
  const tagCTInput = document.getElementById('tagCT');
  const tagTInput = document.getElementById('tagT');
  const tagAllInput = document.getElementById('tagAll');
  const autoSwitch = document.getElementById('autoSwitch');
  const relaySwitch = document.getElementById('relaySwitch');
  const outSwitch = document.getElementById('outSwitch');
  const myNameInput = document.getElementById('myName');
  const outgoingTargetInput = document.getElementById('outgoingTarget');
  const saveBtn = document.getElementById('saveBtn');
  const restartBtn = document.getElementById('restartBtn');

  const segTheme = document.getElementById('segTheme');
  const segSize  = document.getElementById('segSize');
  const swatches = document.getElementById('swatches');
  const accentPicker = document.getElementById('accentPicker');
  const fontSel = document.getElementById('fontSel');
  const resetAppearanceBtn = document.getElementById('resetAppearance');

  const LS_SIDEBAR    = 'cs2ct.sidebar';
  const LS_APPEARANCE = 'cs2ct.appearance';

  let autoTranslateOn = true;
  let relayToChatOn = false;
  let translateOutgoingOn = true;
  let hasEntry = false;

  /* --------------------------------------------------------
   * Helpers
   * ------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0,8);
  }
  function atBottom() {
    return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
  }
  function darken(hex, factor) {
    const h = (hex || '').replace('#','');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(h)) return '#77602a';
    const n = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
    const r = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(0,2),16) * factor)));
    const g = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(2,4),16) * factor)));
    const b = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(4,6),16) * factor)));
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  }
  function relLuminance(hex) {
    const h = (hex || '#888888').replace('#','');
    const n = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
    const [r,g,b] = [0,2,4].map(i => parseInt(n.slice(i,i+2),16) / 255).map(v =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    );
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }

  /* --------------------------------------------------------
   * Feed renderers
   * ------------------------------------------------------ */
  function append(html) {
    if (!hasEntry) { feedEmpty.remove(); hasEntry = true; }
    const wasBottom = atBottom();
    feedEl.insertAdjacentHTML('beforeend', html);
    if (wasBottom) feedEl.scrollTop = feedEl.scrollHeight;
    while (feedEl.children.length > 400) feedEl.removeChild(feedEl.firstElementChild);
  }
  function renderChat(evt) {
    const { team, sender, message } = evt.payload;
    const tagClass = team === 'CT' ? 'ct' : team === 'T' ? 't' : 'all';
    append(
      '<div class="entry chat">' +
        '<div class="meta">' + fmtTime(evt.at) + '</div>' +
        '<div class="body"><div class="line">' +
          '<span class="tag ' + tagClass + '">' + escapeHtml(team) + '</span>' +
          '<span class="sender">' + escapeHtml(sender) + '</span>' +
          '<span class="msg">: ' + escapeHtml(message) + '</span>' +
        '</div></div>' +
      '</div>'
    );
  }
  function renderAuto(evt) {
    const p = evt.payload;
    append(
      '<div class="entry auto">' +
        '<div class="meta">' + fmtTime(evt.at) + '</div>' +
        '<div class="body"><div class="line translation">' +
          '<span class="lang">' + escapeHtml(p.fromName) + '</span>' +
          '<span class="arrow">→</span>' +
          '<span class="lang">' + escapeHtml(p.target.toUpperCase()) + '</span>' +
          '  <span class="translated">' + escapeHtml(p.translated) + '</span>' +
        '</div></div>' +
      '</div>'
    );
  }
  function renderVoice(evt) {
    const p = evt.payload;
    append(
      '<div class="entry auto">' +
        '<div class="meta">' + fmtTime(evt.at) + ' · voice</div>' +
        '<div class="body"><div class="line translation">' +
          '<span class="lang">🎤 ' + escapeHtml(p.fromName || '?') + '</span>' +
          '<span class="arrow">→</span>' +
          '<span class="lang">' + escapeHtml((p.target || '').toUpperCase()) + '</span>' +
          '  <span class="translated">' + escapeHtml(p.translated || p.original || '') + '</span>' +
          (p.original && p.translated && p.original !== p.translated
            ? '<div style="margin-top:2px;color:var(--muted-2)">' + escapeHtml(p.original) + '</div>'
            : '') +
        '</div></div>' +
      '</div>'
    );
  }
  function renderCommand(evt) {
    const p = evt.payload;
    let body = '';
    if (p.kind === 'tm' || p.kind === 'tl') {
      body =
        '<span class="kind">' + (p.kind === 'tm' ? 'tm_' + escapeHtml(p.target) : '_tl ' + escapeHtml(p.target)) + '</span>' +
        '<span class="sender">' + escapeHtml(p.sender) + '</span>' +
        '<span class="msg">: ' + escapeHtml(p.translated) + '</span>' +
        '<div class="translation" style="margin-top:2px;"><span class="lang">from ' + escapeHtml(p.from) + '</span>  <span style="color:var(--muted-2)">' + escapeHtml(p.original) + '</span></div>';
    } else if (p.kind === 'my_trans') {
      body =
        '<span class="kind">t_' + escapeHtml(p.target) + '</span>' +
        '<span class="msg">auto-sent: ' + escapeHtml(p.translated) + '</span>' +
        '<div class="translation" style="margin-top:2px;"><span style="color:var(--muted-2)">' + escapeHtml(p.original) + '</span></div>';
    } else if (p.kind === 'code') {
      body =
        '<span class="kind">code</span>' +
        '<span class="msg">' + escapeHtml(p.reply) + '</span>';
    }
    append(
      '<div class="entry command">' +
        '<div class="meta">' + fmtTime(evt.at) + '</div>' +
        '<div class="body"><div class="line">' + body + '</div></div>' +
      '</div>'
    );
  }
  function renderSystem(text) {
    append(
      '<div class="entry system">' +
        '<div class="meta">' + fmtTime(Date.now()) + '</div>' +
        '<div class="body"><div class="line">' + escapeHtml(text) + '</div></div>' +
      '</div>'
    );
  }
  function renderError(text) {
    append(
      '<div class="entry error">' +
        '<div class="meta">' + fmtTime(Date.now()) + '</div>' +
        '<div class="body"><div class="line">' + escapeHtml(text) + '</div></div>' +
      '</div>'
    );
  }

  function updateStatus(s) {
    if (!s) return;
    statusEl.classList.remove('on', 'bad', 'off');
    const feedHint = document.getElementById('feedHint');
    const warn = s.error || s.warning || '';

    if (s.watching) {
      if (warn) {
        statusEl.classList.add('bad');
        statusLabel.textContent = (s.logSize === 0) ? 'log empty — need -condebug' : 'watching (warn)';
        warnBanner.classList.remove('hidden');
        warnBanner.textContent = warn;
        if (feedHint) feedHint.textContent = warn;
      } else {
        statusEl.classList.add('on');
        statusLabel.textContent = 'watching console.log';
        warnBanner.classList.add('hidden');
        if (feedHint) {
          feedHint.textContent = 'listening for new chat lines in console.log…';
        }
      }
    } else {
      statusEl.classList.add('bad');
      statusLabel.textContent = s.error ? 'stopped' : 'idle';
      if (warn) {
        warnBanner.classList.remove('hidden');
        warnBanner.textContent = warn;
        if (feedHint) feedHint.textContent = warn;
      }
    }
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case 'chat':    renderChat(evt); break;
      case 'auto':    renderAuto(evt); break;
      case 'voice':   renderVoice(evt); break;
      case 'command': renderCommand(evt); break;
      case 'status':  updateStatus(evt.payload); break;
      case 'error':   renderError(evt.payload.message); break;
      case 'cfg':     break;
      default: break;
    }
  }

  function setToast(text, cls) {
    toast.textContent = text || '';
    toast.className = 'toast' + (cls ? ' ' + cls : '');
    if (text) setTimeout(() => {
      if (toast.textContent === text) { toast.textContent=''; toast.className='toast'; }
    }, 2800);
  }

  function setSwitch(on) {
    autoTranslateOn = !!on;
    autoSwitch.classList.toggle('on', autoTranslateOn);
    autoSwitch.setAttribute('aria-checked', String(autoTranslateOn));
  }
  function setRelaySwitch(on) {
    relayToChatOn = !!on;
    if (relaySwitch) {
      relaySwitch.classList.toggle('on', relayToChatOn);
      relaySwitch.setAttribute('aria-checked', String(relayToChatOn));
    }
  }
  function setOutSwitch(on) {
    translateOutgoingOn = !!on;
    if (outSwitch) {
      outSwitch.classList.toggle('on', translateOutgoingOn);
      outSwitch.setAttribute('aria-checked', String(translateOutgoingOn));
    }
  }
  autoSwitch.addEventListener('click', () => setSwitch(!autoTranslateOn));
  autoSwitch.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSwitch(!autoTranslateOn); }
  });
  if (relaySwitch) {
    relaySwitch.addEventListener('click', () => setRelaySwitch(!relayToChatOn));
    relaySwitch.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setRelaySwitch(!relayToChatOn); }
    });
  }
  if (outSwitch) {
    outSwitch.addEventListener('click', () => setOutSwitch(!translateOutgoingOn));
    outSwitch.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setOutSwitch(!translateOutgoingOn); }
    });
  }

  /* --------------------------------------------------------
   * Sidebar toggle
   * ------------------------------------------------------ */
  function applySidebar(visible) {
    mainEl.classList.toggle('aside-hidden', !visible);
    asideToggle.setAttribute('aria-expanded', String(visible));
  }
  asideToggle.addEventListener('click', () => {
    const visible = mainEl.classList.contains('aside-hidden');
    applySidebar(visible);
    try { localStorage.setItem(LS_SIDEBAR, visible ? '1' : '0'); } catch {}
  });
  // Ctrl+B / Cmd+B shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault(); asideToggle.click();
    }
  });
  try {
    const saved = localStorage.getItem(LS_SIDEBAR);
    applySidebar(saved === null ? true : saved === '1');
  } catch { applySidebar(true); }

  /* --------------------------------------------------------
   * Appearance
   * ------------------------------------------------------ */
  const DEFAULT_APPEARANCE = {
    theme: 'dark',
    size: 'md',
    accent: '#d9a84b',
    font: '"JetBrains Mono", ui-monospace, monospace'
  };

  function loadAppearance() {
    try {
      const raw = localStorage.getItem(LS_APPEARANCE);
      if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT_APPEARANCE };
  }
  function saveAppearance(a) {
    try { localStorage.setItem(LS_APPEARANCE, JSON.stringify(a)); } catch {}
  }

  function applyAppearance(a) {
    const root = document.documentElement;
    root.dataset.theme = a.theme;
    root.dataset.size  = a.size;
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-dim', darken(a.accent, 0.55));
    // Pick a legible ink color for the accent button (black on light accents, white on dark accents)
    root.style.setProperty('--accent-ink', relLuminance(a.accent) > 0.55 ? '#1a1205' : '#fafaf7');
    root.style.setProperty('--font', a.font);

    // Reflect into controls
    [...segTheme.children].forEach(b => b.classList.toggle('active', b.dataset.val === a.theme));
    [...segSize.children].forEach(b => b.classList.toggle('active', b.dataset.val === a.size));
    [...swatches.querySelectorAll('.swatch')].forEach(s =>
      s.classList.toggle('active', s.dataset.val.toLowerCase() === a.accent.toLowerCase()));
    accentPicker.value = a.accent;
    fontSel.value = a.font;
  }

  let appearance = loadAppearance();
  applyAppearance(appearance);

  function updateAppearance(patch) {
    appearance = { ...appearance, ...patch };
    applyAppearance(appearance);
    saveAppearance(appearance);
  }

  segTheme.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    updateAppearance({ theme: btn.dataset.val });
  });
  segSize.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    updateAppearance({ size: btn.dataset.val });
  });
  swatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch'); if (!sw) return;
    updateAppearance({ accent: sw.dataset.val });
  });
  accentPicker.addEventListener('input', (e) => {
    updateAppearance({ accent: e.target.value });
  });
  fontSel.addEventListener('change', (e) => {
    updateAppearance({ font: e.target.value });
  });
  resetAppearanceBtn.addEventListener('click', () => {
    updateAppearance({ ...DEFAULT_APPEARANCE });
  });

  /* --------------------------------------------------------
   * Config load / save
   * ------------------------------------------------------ */
  async function loadState() {
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch('/api/config').then(r => r.json()),
        fetch('/api/status').then(r => r.json())
      ]);
      logPathInput.value = cfgRes.logPath || '';
      cfgDirInput.value  = cfgRes.cfgDir || '';
      bindKeyInput.value = cfgRes.bindKey || '';
      autoTargetInput.value = (cfgRes.autoTranslateTarget || 'en').toLowerCase();
      tagCTInput.value = cfgRes.tagCT || 'CT';
      tagTInput.value  = cfgRes.tagT  || 'T';
      tagAllInput.value = cfgRes.tagAll || 'ALL';
      if (myNameInput) myNameInput.value = cfgRes.myName || '';
      if (outgoingTargetInput) outgoingTargetInput.value = (cfgRes.outgoingTarget || 'en').toLowerCase();
      setSwitch(cfgRes.autoTranslate !== false);
      setRelaySwitch(cfgRes.relayToChat === true);
      setOutSwitch(cfgRes.translateOutgoing !== false);
      updateStatus(statusRes);
      if (statusRes.configPath) {
        cfgPathHint.textContent = 'config: ' + statusRes.configPath;
      }
    } catch (err) {
      setToast('Failed to load config: ' + err.message, 'err');
    }
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const body = {
        logPath: logPathInput.value.trim(),
        cfgDir:  cfgDirInput.value.trim(),
        bindKey: bindKeyInput.value.trim() || 'l',
        autoTranslate: autoTranslateOn,
        autoTranslateTarget: (autoTargetInput.value.trim() || 'en').toLowerCase(),
        relayToChat: relayToChatOn,
        translateOutgoing: translateOutgoingOn,
        myName: myNameInput ? myNameInput.value.trim() : '',
        outgoingTarget: outgoingTargetInput
          ? (outgoingTargetInput.value.trim() || 'en').toLowerCase()
          : 'en',
        tagCT:  tagCTInput.value.trim() || 'CT',
        tagT:   tagTInput.value.trim()  || 'T',
        tagAll: tagAllInput.value.trim() || 'ALL'
      };
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const saved = await res.json();
      setToast('Saved.', 'ok');
      renderSystem('Config saved. Tags: ['+saved.tagCT+'] ['+saved.tagT+'] ['+saved.tagAll+']');
    } catch (err) {
      setToast('Save failed: ' + err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  restartBtn.addEventListener('click', async () => {
    restartBtn.disabled = true;
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      const s = await res.json();
      updateStatus(s);
      setToast(s.watching ? 'Watcher restarted.' : 'Watcher idle.', s.watching ? 'ok' : 'err');
    } catch (err) {
      setToast('Restart failed: ' + err.message, 'err');
    } finally {
      restartBtn.disabled = false;
    }
  });

  function connectStream() {
    const es = new EventSource('/events');
    es.addEventListener('chat',    e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('auto',    e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('voice',   e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('command', e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('status',  e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('error',   e => { try { handleEvent(JSON.parse(e.data)); } catch {} });
    es.addEventListener('cfg',     e => handleEvent(JSON.parse(e.data)));
    es.onerror = () => {
      statusEl.classList.remove('on'); statusEl.classList.add('bad');
      statusLabel.textContent = 'reconnecting…';
    };
  }

  loadState().then(connectStream);
</script>
</body>
</html>`;

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function startWebServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // UI
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(INDEX_HTML);
      return;
    }

    // SSE
    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(":ok\n\n");
      // Snapshot current status + replay recent events so new clients get context
      res.write(
        `event: status\ndata: ${JSON.stringify({ type: "status", payload: statusSnapshot(), at: Date.now() })}\n\n`
      );
      const tail = recentEvents.slice(-60);
      for (const evt of tail) {
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
      sseClients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(":keepalive\n\n"); } catch { /* noop */ }
      }, 20000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    // Config: GET
    if (req.method === "GET" && p === "/api/config") {
      sendJson(res, loadConfig());
      return;
    }

    // Config: POST
    if (req.method === "POST" && p === "/api/config") {
      try {
        const body = await readJsonBody(req);
        const next = {
          logPath: typeof body.logPath === "string" ? body.logPath : undefined,
          cfgDir: typeof body.cfgDir === "string" ? body.cfgDir : undefined,
          bindKey: typeof body.bindKey === "string" ? body.bindKey : undefined,
          autoTranslate:
            typeof body.autoTranslate === "boolean" ? body.autoTranslate : undefined,
          autoTranslateTarget:
            typeof body.autoTranslateTarget === "string"
              ? body.autoTranslateTarget
              : undefined,
          relayToChat:
            typeof body.relayToChat === "boolean" ? body.relayToChat : undefined,
          translateOutgoing:
            typeof body.translateOutgoing === "boolean"
              ? body.translateOutgoing
              : undefined,
          myName: typeof body.myName === "string" ? body.myName : undefined,
          outgoingTarget:
            typeof body.outgoingTarget === "string"
              ? body.outgoingTarget
              : undefined,
          tagCT: typeof body.tagCT === "string" ? body.tagCT : undefined,
          tagT: typeof body.tagT === "string" ? body.tagT : undefined,
          tagAll: typeof body.tagAll === "string" ? body.tagAll : undefined
        };
        const cur = loadConfig();
        const merged = saveConfig({ ...cur, ...Object.fromEntries(
          Object.entries(next).filter(([, v]) => v !== undefined)
        )});
        setupFromConfig();
        startWatching();
        broadcast("status", statusSnapshot());
        sendJson(res, merged);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
      return;
    }

    // Status
    if (req.method === "GET" && p === "/api/status") {
      sendJson(res, statusSnapshot());
      return;
    }

    // Restart watcher
    if (req.method === "POST" && p === "/api/restart") {
      setupFromConfig();
      startWatching();
      sendJson(res, statusSnapshot());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.on("error", (err) => {
    console.error(chalk.red(`HTTP server error: ${err.message}`));
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(sym.start, chalk.bold(`CS2 Chat Translator`));
    console.log(sym.info, `GUI ready at ${chalk.underline(url)}`);
    console.log(chalk.gray(`   config: ${CONFIG_PATH}`));
  });

  return server;
}

function openBrowser(url) {
  // Linux-first (xdg-open), with macOS/Windows fallbacks in case someone runs it there.
  const cmd =
    process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  execChild(cmd, (err) => {
    if (err) log(sym.warn, chalk.yellow(`Could not auto-open browser: ${err.message}`));
  });
}

// -----------------------------------------------------------------------------
// CLI parsing and startup
// -----------------------------------------------------------------------------

function printCliHelp() {
  console.log("CS2 Sesli Translator");
  console.log("https://github.com/lmaskeml/cs2translator");
  console.log("");
  console.log("Kullanım:");
  console.log("  cs2translator                 # izleyici + web arayüzü");
  console.log("  cs2translator --voice         # + sesli çeviri (WASAPI + Whisper)");
  console.log("  cs2translator --no-browser    # tarayıcıyı açma");
  console.log("  cs2translator --port 1234     # web portu (varsayılan 7420)");
  console.log("  cs2translator --cli           # sadece konsol");
  console.log("  cs2translator --init-config");
  console.log("  cs2translator --set-log-path <yol>");
  console.log("  cs2translator --set-cfg-dir <yol>");
  console.log("  cs2translator --set-bind-key l");
  console.log("  cs2translator --ensure-condebug");
  console.log("  cs2translator --list-voice-devices");
  console.log("");
  console.log("Oyun içi komutlar:");
  console.log("  tm_<dil> METİN    çevirip sohbete gönder");
  console.log("  t_<dil> METİN     ham çeviriyi sohbete gönder");
  console.log("  _tl [dil]         son mesajı çevir (varsayılan tr)");
  console.log("  code_<diladı>     dil kodu yardımcısı");
}

/**
 * Patch Steam userdata localconfig.vdf so CS2 (app 730) launch options include -condebug.
 * Steam may need a restart for the change to stick if it already has the file loaded.
 */
function ensureCondebugCli() {
  const steamRoot =
    process.platform === "win32"
      ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam")
      : path.join(os.homedir(), ".local/share/Steam");
  const userdata = path.join(steamRoot, "userdata");
  if (!fs.existsSync(userdata)) {
    console.error(chalk.red(`Steam userdata not found: ${userdata}`));
    process.exit(1);
  }

  const candidates = [];
  for (const id of fs.readdirSync(userdata)) {
    const p = path.join(userdata, id, "config", "localconfig.vdf");
    if (fs.existsSync(p)) candidates.push(p);
  }
  if (!candidates.length) {
    console.error(chalk.red("No Steam localconfig.vdf found under userdata."));
    process.exit(1);
  }

  let changed = 0;
  let already = 0;
  for (const cfgPath of candidates) {
    const text = fs.readFileSync(cfgPath, "utf8");
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    let in730 = false;
    let depth = 0;
    let hit = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!in730 && (/^\s*"730"\s*$/.test(line) || /^\s*"730"\s*\{/.test(line))) {
        in730 = true;
        depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        continue;
      }
      if (!in730) continue;

      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

      const lo = line.match(/^(\s*"LaunchOptions"\s*")([^"]*)(".*)$/);
      if (lo) {
        hit = true;
        const cur = lo[2];
        if (/(^|\s)-condebug(\s|$)/i.test(cur)) {
          already++;
          console.log(chalk.gray(`Already has -condebug: ${cfgPath}`));
        } else {
          const next = (`-condebug ${cur}`).trim();
          lines[i] = `${lo[1]}${next}${lo[3]}`;
          fs.writeFileSync(cfgPath, lines.join(nl), "utf8");
          changed++;
          console.log(chalk.green(`Added -condebug → ${cfgPath}`));
          console.log(chalk.gray(`  LaunchOptions: ${next}`));
        }
        break;
      }

      if (depth <= 0) in730 = false;
    }

    if (!hit) {
      console.log(chalk.yellow(`No apps/730 LaunchOptions in ${cfgPath} (skipped)`));
    }
  }

  console.log("");
  if (changed) {
    console.log(chalk.yellow("⚠️  Fully quit CS2 and Steam, then start Steam → CS2 again."));
    console.log(chalk.yellow("    After relaunch, console.log should grow while you play."));
  } else if (already) {
    console.log(chalk.green("Launch options already include -condebug. Restart CS2 if the log is still empty."));
  } else {
    console.log(chalk.red("Could not find CS2 LaunchOptions. Add -condebug manually in Steam → CS2 → Properties → Launch Options."));
    process.exit(1);
  }
}

async function startAll({ withGui, port, openUi, voice }) {
  setupFromConfig();
  if (voice) VOICE_ENABLED = true;
  startWatching();
  if (VOICE_ENABLED) startVoiceTranslate();

  if (withGui) {
    startWebServer(port);
    if (openUi) setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 250);
  } else {
    // Headless banner for --cli
    console.log(sym.start, chalk.bold(`CS2 Chat Translator (headless)\n`));
    console.log(chalk.gray("Commands: tm_<lang> TEXT | t_<lang> TEXT | _tl [lang] | code_<lang>"));
    if (VOICE_ENABLED) console.log(chalk.gray("Voice: WASAPI loopback → Whisper → console"));
  }
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printCliHelp();
  process.exit(0);
}

if (args[0] === "--init-config") {
  initConfigCli();
  process.exit(0);
}

if (args[0] === "--set-log-path" && args[1]) {
  updateConfigKey("logPath", path.resolve(args[1]));
  process.exit(0);
}

if (args[0] === "--set-cfg-dir" && args[1]) {
  updateConfigKey("cfgDir", path.resolve(args[1]));
  process.exit(0);
}

if (args[0] === "--set-bind-key" && args[1]) {
  updateConfigKey("bindKey", args[1]);
  process.exit(0);
}

if (args[0] === "--ensure-condebug") {
  ensureCondebugCli();
  process.exit(0);
}

if (args[0] === "--list-voice-devices") {
  const py = voicePythonPath();
  if (!py) {
    console.error("Voice venv missing. See requirements-voice.txt");
    process.exit(1);
  }
  const r = spawnSync(py, [path.join(__dirname, "voice_worker.py"), "--list-devices"], {
    encoding: "utf8"
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  process.exit(r.status || 0);
}

// Default mode: start watcher (+ GUI unless --cli)
const portArgIdx = args.indexOf("--port");
const port = portArgIdx !== -1 && args[portArgIdx + 1]
  ? Number(args[portArgIdx + 1])
  : 7420;
const withGui = !args.includes("--cli");
const openUi = withGui && !args.includes("--no-browser");
const voice = args.includes("--voice");

startAll({ withGui, port, openUi, voice }).catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});
