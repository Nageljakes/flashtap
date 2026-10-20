/**
 * ⚡ FlashTap licensing core.
 * No electron imports — plain node so it can be exercised on any machine.
 *
 * Flow enforced by main.cjs:
 *   1. On every launch the app validates with the license server (10s timeout).
 *      ok      -> refresh `until` and continue
 *      revoked -> lock the app
 *      unreachable -> keep running on the 7-day grace recorded in `until`
 *   2. No state / grace expired -> activation screen (needs internet once).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");

const LICENSE_URLS = (process.env.FLASHTAP_LICENSE_URL ||
  "https://tiny.tail5f36c9.ts.net,http://192.168.110.8:3211")
  .split(",").map((s) => s.trim()).filter(Boolean);

const keyRe = /^FT-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;

function statePath(userDataDir) {
  return path.join(userDataDir, "license.json");
}
function machinePath(userDataDir) {
  return path.join(userDataDir, "machine.json");
}

function loadState(userDataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(userDataDir), "utf8"));
    if (j && typeof j === "object") return j;
  } catch {}
  return null;
}
function saveState(userDataDir, state) {
  try {
    fs.writeFileSync(statePath(userDataDir), JSON.stringify(state, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
function clearState(userDataDir) {
  try { fs.unlinkSync(statePath(userDataDir)); } catch {}
}

function machineId(userDataDir) {
  const p = machinePath(userDataDir);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j && j.id) return j.id;
  } catch {}
  const id = crypto.randomUUID();
  try { fs.writeFileSync(p, JSON.stringify({ id, host: os.hostname() }, null, 2) + "\n"); } catch {}
  return id;
}

/** POST {body} to /v1/<path> on each candidate base URL; first one that answers wins. */
function callServer(apiPath, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const attempt = (urls) => {
      const base = urls[0];
      if (base === undefined) return settle({ reachable: false });
      let full;
      try { full = new URL(apiPath, base); } catch { return attempt(urls.slice(1)); }
      const mod = full.protocol === "https:" ? https : http;
      const data = JSON.stringify(body || {});
      const done = () => settle({ reachable: false });   // timeout/error -> try fallbacks
      const req = mod.request(
        full,
        { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: timeoutMs },
        (res) => {
          let s = "";
          res.on("data", (d) => (s += d));
          res.on("end", () => {
            if (settled) return;
            try { settle({ reachable: true, status: res.statusCode, ...JSON.parse(s || "{}") }); }
            catch { settle({ reachable: true, status: res.statusCode }); }
          });
        }
      );
      req.on("timeout", () => { req.destroy(); done(); });
      req.on("error", done);
      req.end(data);
    };
    attempt([...LICENSE_URLS]);
  });
}

/**
 * Startup decision. Non-throwing: everything becomes a status string.
 *   ok | revoked | activate
 */
async function evaluate(userDataDir) {
  const state = loadState(userDataDir);
  const mid = machineId(userDataDir);
  const stateFilePath = statePath(userDataDir);

  const graceLeft = () => (state && state.until ? state.until - Date.now() : -1);

  if (!state || !state.key || !keyRe.test(state.key)) return { status: "activate", machineId: mid };

  // Try a check with the server (fast, non-blocking failure).
  const v = await callServer("/v1/validate", { key: state.key, machineId: mid });
  if (v.reachable) {
    if (v.ok) {
      const fresh = { ...state, until: v.until || Date.now() + 7 * 24 * 3600e3, lastCheck: Date.now() };
      saveState(userDataDir, fresh);
      return { status: "ok", state: fresh, machineId: mid };
    }
    if (v.reason === "revoked") {
      // keep the key stored: after a reinstate the next launch auto-unlocks
      saveState(userDataDir, { ...state, until: 0, lastCheck: Date.now() });
      return { status: "revoked", reason: "revoked", machineId: mid };
    }
    if (v.reason === "needs-activation") {
      // DB reset / binding removed -> activate again with the stored key
      return { status: "activate", reason: v.reason, machineId: mid, savedKey: state.key };
    }
    if (v.reason === "unknown-key") { clearState(userDataDir); return { status: "activate", reason: v.reason, machineId: mid }; }
    // unknown malformed response -> defer to grace
  }
  return graceLeft() > 0
    ? { status: "ok", state, machineId: mid, offlineGrace: true }
    : { status: "activate", reason: "grace-expired", machineId: mid };
}

/** Bind key <-> machine. Returns {ok}|{ok:false, reason}|{reachable:false}. */
async function activate(userDataDir, rawKey, machineName) {
  const key = String(rawKey || "").trim().toUpperCase();
  if (!keyRe.test(key)) return { ok: false, reachable: true, reason: "Key format looks wrong — it should read FT-XXXXX-XXXXX-XXXXX." };
  const mid = machineId(userDataDir);
  const r = await callServer("/v1/activate", { key, machineId: mid, machineName: machineName || os.hostname() }, 15000);
  if (!r.reachable) return { ok: false, reachable: false, reason: "License server unreachable. Connect to the internet once to activate." };
  if (r.ok) {
    const state = { key, machineId: mid, until: r.until || Date.now() + 7 * 24 * 3600e3, lastCheck: Date.now() };
    saveState(userDataDir, state);
    return { ok: true, state };
  }
  const copy = {
    "unknown-key": "That key isn't recognised. Check spelling — format FT-XXXXX-XXXXX-XXXXX.",
    "revoked": "This key has been revoked. Please contact the issuer.",
    "limit-reached": `Key already used on ${r.maxMachines || 2} machines. Request a free re-bind from the issuer.`,
    "malformed-key": "That key doesn't look valid. Format: FT-XXXXX-XXXXX-XXXXX.",
  }[r.reason] || `Activation failed: ${r.reason || "unknown error"}`;
  return { ok: false, reachable: true, reason: copy, code: r.reason };
}

module.exports = {
  LICENSE_URLS, keyRe,
  loadState, saveState, clearState, machineId,
  callServer, evaluate, activate,
  statePath,
};
