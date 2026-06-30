#!/usr/bin/env node
/**
 * agent-browser-plugin-userprofile-browser
 * browser.provider plugin for agent-browser
 *
 * Acts as the browser provider (`--provider userprofile-browser`). On
 * `browser.launch` it performs a ONE-TIME full rsync of the real Chrome profile
 * into a separate "RemoteDebug" user-data-dir — bypassing the "non-default data
 * directory" detection used by some anti-bot sites and the live-profile lock —
 * then launches Chrome from that copy with a remote-debugging port and returns
 * the CDP WebSocket URL so agent-browser can drive the logged-in profile.
 *
 * Capability: browser.provider
 * Request types:
 *   - browser.launch : rsync profile + launch (or connect) Chrome,
 *                      returns { browser: { cdpUrl, directPage, metadata, cleanup } }
 *   - browser.close  : terminate the Chrome started by browser.launch (by
 *                      sessionId), returns { data: { closed } }
 *
 * Protocol: agent-browser.plugin.v1 (stdin/stdout JSON)
 *
 * Live Chrome processes are tracked in a local session registry file so that a
 * subsequent `browser.close` (a separate process) can terminate them. The
 * plugin never deletes profile lock files of the *real* Chrome.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { execFileSync, spawn } from "child_process";
import { homedir, platform } from "os";
import { basename, dirname, join, resolve } from "path";
import { setTimeout as sleep } from "timers/promises";

// ─── Protocol Types ──────────────────────────────────────────────────────────

interface PluginEnvelope<TRequest = unknown> {
  protocol?: string;
  type?: string;
  capability?: string;
  request?: TRequest;
  id?: string;
}

interface PluginSuccessResponse {
  protocol: "agent-browser.plugin.v1";
  success: true;
  [key: string]: unknown;
}

interface PluginErrorResponse {
  protocol: "agent-browser.plugin.v1";
  success: false;
  error: {
    code: string;
    message: string;
  };
}

interface PluginManifestResponse extends PluginSuccessResponse {
  manifest: {
    name: string;
    capabilities: string[];
    description: string;
  };
}

interface CommandRunResponse extends PluginSuccessResponse {
  data: Record<string, unknown>;
}

interface BrowserProviderResponse extends PluginSuccessResponse {
  browser: {
    cdpUrl: string;
    directPage: boolean;
    metadata: Record<string, unknown>;
    cleanup: {
      sessionId: string;
    };
  };
}

type PluginResponse =
  | PluginManifestResponse
  | CommandRunResponse
  | BrowserProviderResponse
  | PluginErrorResponse;

interface BrowserLaunchRequest {
  /** Source Chrome user-data-dir to copy FROM (the real profile). */
  userDataDir?: string;
  /** Profile sub-directory name, e.g. "Default". */
  profileDirectory?: string;
  /** Target "RemoteDebug" user-data-dir to copy TO and launch FROM. */
  debugDir?: string;
  /** Chrome/Chromium executable path. Auto-detected when omitted. */
  executablePath?: string;
  /** Connect to an already-running Chrome at this CDP URL instead of launching. */
  cdpUrl?: string;
  /** Remote-debugging port; 0 / omitted lets Chrome pick a free port. */
  port?: number;
  /** Extra Chrome launch args. */
  args?: string[];
  /** Force re-sync even if the profile was already synced. */
  force?: boolean;
}

interface BrowserCloseRequest {
  /** Session id returned by browser.launch (cleanup.sessionId). */
  sessionId?: string;
  /** Remove the synced debug directory in addition to closing Chrome. */
  removeDebugDir?: boolean;
}

interface ProfileState {
  userDataDir: string;
  profileDirectory: string;
  source: string;
  syncedAt: string;
}

interface SessionEntry {
  sessionId: string;
  mode: "launch" | "connect";
  pid?: number;
  port?: number;
  cdpUrl: string;
  userDataDir: string;
  profileDirectory: string;
  startedAt: string;
}

type SessionRegistry = Record<string, SessionEntry>;

class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProviderError";
  }
}

// ─── File Logger ──────────────────────────────────────────────────────────────
// Writes JSON-lines to logs/agent-browser-plugin-userprofile-browser.log under
// the CWD. Do not log cookie values, tokens, or profile file contents.

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "agent-browser-plugin-userprofile-browser.log");

function fileLog(event: string, data?: unknown): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      plugin: "agent-browser-plugin-userprofile-browser",
      event,
      ...(data !== undefined ? { data } : {}),
    });
    appendFileSync(LOG_FILE, entry + "\n");
  } catch {
    process.stderr.write(
      `[agent-browser-plugin-userprofile-browser][fileLog error] could not write to ${LOG_FILE}\n`
    );
  }
}

function stderr(msg: string): void {
  process.stderr.write(`[agent-browser-plugin-userprofile-browser] ${msg}\n`);
}

// ─── Path and Profile Resolution ──────────────────────────────────────────────

function expandHome(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function resolvePath(p: string): string {
  return resolve(expandHome(p));
}

function getDefaultUserDataDir(): string {
  const plat = platform();
  if (plat === "darwin") {
    return expandHome("~/Library/Application Support/Google/Chrome");
  }

  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? expandHome("~/.config");
  const googleChrome = join(xdgConfig, "google-chrome");
  if (existsSync(googleChrome)) {
    return googleChrome;
  }

  const chromium = join(xdgConfig, "chromium");
  if (existsSync(chromium)) {
    return chromium;
  }

  return googleChrome;
}

function getDefaultDebugDir(sourceUserDataDir: string): string {
  return join(dirname(sourceUserDataDir), `${basename(sourceUserDataDir)}RemoteDebug`);
}

// ─── Local config file ────────────────────────────────────────────────────────
// agent-browser spawns plugins as subprocesses, so environment variables cannot
// be relied on to reach them. Configuration is therefore read from a local JSON
// file (shared with agent-browser-plugin-stealth). Env vars remain only as an
// optional last-resort fallback.

interface UserProfileConfig {
  /** Source Chrome user-data-dir to copy FROM. */
  userDataDir?: string;
  /** Profile sub-directory name, e.g. "Default". */
  profileDirectory?: string;
  /** Target "RemoteDebug" user-data-dir to copy TO and launch FROM. */
  debugDir?: string;
  /** Override path of the persisted state file. */
  statePath?: string;
}

function getConfigPath(): string {
  return join(process.cwd(), ".agent-browser", "userprofile.config.json");
}

function readConfig(): UserProfileConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as UserProfileConfig;
    }
  } catch {
    stderr(`Failed to parse config at ${configPath}; ignoring.`);
  }
  return {};
}

// ─── Persisted state (shared with agent-browser-plugin-stealth) ───────────────

function getStatePath(config: UserProfileConfig): string {
  const chosen = config.statePath ?? process.env["AGENT_BROWSER_USERPROFILE_STATE"];
  if (chosen && chosen.trim()) {
    return resolvePath(chosen.trim());
  }
  return join(process.cwd(), ".agent-browser", "userprofile-browser-state.json");
}

function readState(statePath: string): ProfileState | null {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProfileState>;
    if (typeof parsed.userDataDir === "string" && typeof parsed.profileDirectory === "string") {
      return {
        userDataDir: parsed.userDataDir,
        profileDirectory: parsed.profileDirectory,
        source: typeof parsed.source === "string" ? parsed.source : "",
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : "",
      };
    }
  } catch {
    stderr(`Failed to parse existing state file at ${statePath}`);
  }
  return null;
}

function writeState(state: ProfileState, statePath: string): string {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  return statePath;
}

function removeState(statePath: string): boolean {
  if (!existsSync(statePath)) {
    return false;
  }
  rmSync(statePath, { force: true });
  return true;
}

// ─── rsync profile sync ───────────────────────────────────────────────────────

// rsync exit codes 23/24 mean some files were skipped (vanished/partial),
// which is expected when syncing a live Chrome profile. Treat them as success.
const RSYNC_OK_CODES = new Set([0, 23, 24]);

const RSYNC_EXCLUDES = [
  "LOCK",
  "LOG",
  "LOG.old",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "CrashpadMetrics*",
  "*-journal",
  "*-wal",
  "*-shm",
  "GPUCache/",
  "DawnGraphiteCache/",
  "DawnWebGPUCache/",
  "ShaderCache/",
  "Code Cache/",
];

function syncProfile(sourceProfileDir: string, targetProfileDir: string): void {
  mkdirSync(targetProfileDir, { recursive: true });

  const args = ["-a", "--delete", "--ignore-errors", "--partial"];
  for (const ex of RSYNC_EXCLUDES) {
    args.push(`--exclude=${ex}`);
  }
  // Trailing slash: copy CONTENTS of source into target.
  args.push(`${sourceProfileDir}/`, `${targetProfileDir}/`);

  try {
    execFileSync("rsync", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e: unknown) {
    const code = (e as { status?: number }).status;
    if (typeof code === "number" && RSYNC_OK_CODES.has(code)) {
      stderr(`rsync completed with non-fatal exit code ${code}`);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`rsync failed: ${msg}`);
  }
}

// ─── Session registry ─────────────────────────────────────────────────────────
// Live Chrome processes started by browser.launch are recorded here so a later
// browser.close (a separate plugin process) can terminate them by sessionId.

function getSessionsPath(config: UserProfileConfig): string {
  return join(dirname(getStatePath(config)), "userprofile-browser-sessions.json");
}

function readSessions(sessionsPath: string): SessionRegistry {
  if (!existsSync(sessionsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(sessionsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as SessionRegistry;
    }
  } catch {
    stderr(`Failed to parse session registry at ${sessionsPath}; resetting.`);
  }
  return {};
}

function writeSessions(sessionsPath: string, registry: SessionRegistry): void {
  mkdirSync(dirname(sessionsPath), { recursive: true });
  writeFileSync(sessionsPath, JSON.stringify(registry, null, 2) + "\n");
}

function makeSessionId(mode: "launch" | "connect"): string {
  return `userprofile-${mode}-${process.pid}-${Date.now()}`;
}

// ─── Chrome launch ─────────────────────────────────────────────────────────────

function resolveChromeExecutable(explicit?: string): string {
  if (explicit && explicit.trim()) {
    const p = resolvePath(explicit.trim());
    if (existsSync(p)) {
      return p;
    }
    throw new ProviderError("chrome_not_found", `Chrome executable not found: ${p}`);
  }

  const plat = platform();
  const candidates: string[] = [];

  if (plat === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (plat !== "win32") {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      try {
        const found = execFileSync("which", [name], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        if (found) {
          candidates.push(found);
        }
      } catch {
        // not on PATH; try next
      }
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }

  throw new ProviderError(
    "chrome_not_found",
    "Could not find a Chrome/Chromium executable. Pass request.executablePath."
  );
}

interface LaunchedChrome {
  pid: number;
  port: number;
  cdpUrl: string;
}

async function launchChrome(opts: {
  executablePath?: string;
  userDataDir: string;
  profileDirectory: string;
  port?: number;
  extraArgs: string[];
}): Promise<LaunchedChrome> {
  const exe = resolveChromeExecutable(opts.executablePath);
  const requestedPort =
    typeof opts.port === "number" && opts.port > 0 ? opts.port : 0;

  // Chrome writes the actual port + browser ws path to <user-data-dir>/DevToolsActivePort
  // once the debug server is up. Remove any stale file first.
  const devtoolsPortFile = join(opts.userDataDir, "DevToolsActivePort");
  if (existsSync(devtoolsPortFile)) {
    rmSync(devtoolsPortFile, { force: true });
  }

  const args = [
    `--remote-debugging-port=${requestedPort}`,
    `--user-data-dir=${opts.userDataDir}`,
    `--profile-directory=${opts.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    ...opts.extraArgs,
  ];

  fileLog("chrome.spawn", { exe, args });

  let child;
  try {
    child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderError("launch_failed", `Failed to spawn Chrome: ${msg}`);
  }

  if (typeof child.pid !== "number") {
    throw new ProviderError("launch_failed", "Chrome did not start (no pid).");
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (existsSync(devtoolsPortFile)) {
      const content = readFileSync(devtoolsPortFile, "utf8").trim();
      const lines = content.split("\n");
      const port = parseInt(lines[0] ?? "", 10);
      const wsPath = lines[1];
      if (port > 0 && wsPath && wsPath.startsWith("/")) {
        return { pid: child.pid, port, cdpUrl: `ws://127.0.0.1:${port}${wsPath}` };
      }
    }
    await sleep(150);
  }

  // Timed out — clean up the process we started.
  try {
    process.kill(child.pid);
  } catch {
    // already gone
  }
  throw new ProviderError(
    "launch_failed",
    "Timed out waiting for Chrome DevTools endpoint (DevToolsActivePort)."
  );
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleManifest(): PluginManifestResponse {
  fileLog("handle.manifest");
  const resp: PluginManifestResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    manifest: {
      name: "userprofile-browser",
      capabilities: ["browser.provider"],
      description:
        "Browser provider that rsyncs the real Chrome profile into a RemoteDebug user-data-dir, launches Chrome from it with a remote-debugging port, and returns the CDP URL.",
    },
  };
  fileLog("handle.manifest.response", { manifest: resp.manifest });
  return resp;
}

async function handleBrowserLaunch(
  req: BrowserLaunchRequest
): Promise<BrowserProviderResponse> {
  const config = readConfig();
  const statePath = getStatePath(config);
  const sessionsPath = getSessionsPath(config);

  // Connect mode: a CDP URL was supplied — attach to that Chrome, don't launch.
  if (req.cdpUrl && req.cdpUrl.trim()) {
    const cdpUrl = req.cdpUrl.trim();
    const sessionId = makeSessionId("connect");
    const sessions = readSessions(sessionsPath);
    sessions[sessionId] = {
      sessionId,
      mode: "connect",
      cdpUrl,
      userDataDir: "",
      profileDirectory: "",
      startedAt: new Date().toISOString(),
    };
    writeSessions(sessionsPath, sessions);

    fileLog("handle.browserLaunch.connect", { sessionId, cdpUrl });
    return {
      protocol: "agent-browser.plugin.v1",
      success: true,
      browser: {
        cdpUrl,
        directPage: false,
        metadata: { mode: "connect", sessionId },
        cleanup: { sessionId },
      },
    };
  }

  const source = resolvePath(
    req.userDataDir ??
      config.userDataDir ??
      process.env["AGENT_BROWSER_USERPROFILE_DIR"] ??
      process.env["AGENT_BROWSER_USERPROFILE_NAME"] ??
      getDefaultUserDataDir()
  );
  const profileDirectory =
    req.profileDirectory ??
    config.profileDirectory ??
    process.env["AGENT_BROWSER_PROFILE_DIRECTORY"] ??
    "Default";
  const debugDir = resolvePath(
    req.debugDir ??
      config.debugDir ??
      process.env["AGENT_BROWSER_USERPROFILE_DEBUG_DIR"] ??
      getDefaultDebugDir(source)
  );
  const force = req.force === true;

  fileLog("handle.browserLaunch.request", { source, profileDirectory, debugDir, force });

  // One-time rsync: skip if already synced (state file present) unless force.
  const existing = readState(statePath);
  let synced = false;
  if (existing && !force) {
    stderr(`Profile already synced; skipping rsync (pass force:true to re-sync).`);
  } else {
    if (!existsSync(join(source, profileDirectory))) {
      throw new ProviderError(
        "profile_not_found",
        `Source profile not found: ${join(source, profileDirectory)}`
      );
    }
    syncProfile(join(source, profileDirectory), join(debugDir, profileDirectory));
    synced = true;
    writeState(
      { userDataDir: debugDir, profileDirectory, source, syncedAt: new Date().toISOString() },
      statePath
    );
  }

  // Launch Chrome from the synced copy and obtain the CDP URL.
  const { pid, port, cdpUrl } = await launchChrome({
    executablePath: req.executablePath,
    userDataDir: debugDir,
    profileDirectory,
    port: req.port,
    extraArgs: req.args ?? [],
  });

  const sessionId = makeSessionId("launch");
  const sessions = readSessions(sessionsPath);
  sessions[sessionId] = {
    sessionId,
    mode: "launch",
    pid,
    port,
    cdpUrl,
    userDataDir: debugDir,
    profileDirectory,
    startedAt: new Date().toISOString(),
  };
  writeSessions(sessionsPath, sessions);

  const metadata: Record<string, unknown> = {
    userDataDir: debugDir,
    profileDirectory,
    source,
    mode: "launch",
    sessionId,
    port,
    pid,
    synced,
  };

  fileLog("handle.browserLaunch.response", { ...metadata, cdpUrl });
  return {
    protocol: "agent-browser.plugin.v1",
    success: true,
    browser: {
      cdpUrl,
      directPage: false,
      metadata,
      cleanup: { sessionId },
    },
  };
}

function handleBrowserClose(req: BrowserCloseRequest): CommandRunResponse {
  fileLog("handle.browserClose.request", {
    sessionId: req.sessionId,
    removeDebugDir: req.removeDebugDir === true,
  });

  const config = readConfig();
  const sessionsPath = getSessionsPath(config);
  const sessions = readSessions(sessionsPath);
  const sessionId = req.sessionId;
  const entry = sessionId ? sessions[sessionId] : undefined;

  // Idempotent: unknown / already-closed session is a no-op success.
  if (!sessionId || !entry) {
    const data = { closed: false, noOp: true };
    fileLog("handle.browserClose.response", data);
    return { protocol: "agent-browser.plugin.v1", success: true, data };
  }

  let closed = false;
  if (entry.mode === "launch" && typeof entry.pid === "number") {
    try {
      process.kill(entry.pid);
      closed = true;
    } catch {
      // Process already exited.
    }
  }

  delete sessions[sessionId];
  writeSessions(sessionsPath, sessions);

  let removedDebugDir = false;
  if (req.removeDebugDir === true && entry.userDataDir && existsSync(entry.userDataDir)) {
    rmSync(entry.userDataDir, { recursive: true, force: true });
    removedDebugDir = true;
    // Drop the sync marker so the next launch re-syncs into a fresh dir.
    removeState(getStatePath(config));
  }

  // connect mode never owned a process — report a no-op close.
  if (entry.mode === "connect") {
    const data = { closed: false, noOp: true, removedDebugDir };
    fileLog("handle.browserClose.response", data);
    return { protocol: "agent-browser.plugin.v1", success: true, data };
  }

  const data = { closed, removedDebugDir };
  fileLog("handle.browserClose.response", data);
  return { protocol: "agent-browser.plugin.v1", success: true, data };
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function makeError(code: string, message: string): PluginErrorResponse {
  return {
    protocol: "agent-browser.plugin.v1",
    success: false,
    error: { code, message },
  };
}

// ─── Request Dispatch ─────────────────────────────────────────────────────────

function dispatch(envelope: PluginEnvelope): Promise<PluginResponse> | PluginResponse {
  const isOfficial = envelope.protocol === "agent-browser.plugin.v1";
  const isLegacy = !envelope.protocol;

  fileLog("dispatch.request", {
    type: envelope.type,
    protocol: envelope.protocol ?? "legacy",
  });

  if (!isOfficial && !isLegacy) {
    const err = makeError(
      "unsupported_protocol",
      `Unsupported protocol: ${String(envelope.protocol)}. Expected "agent-browser.plugin.v1".`
    );
    fileLog("dispatch.error", err.error);
    return err;
  }

  const request = (envelope.request ?? {}) as Record<string, unknown>;

  switch (envelope.type) {
    case "plugin.manifest":
      return handleManifest();

    case "browser.launch":
      return handleBrowserLaunch(request as BrowserLaunchRequest);

    case "browser.close":
      return handleBrowserClose(request as BrowserCloseRequest);

    default: {
      const err = makeError(
        "unsupported_type",
        `Unsupported request type: "${String(envelope.type)}". Supported types: plugin.manifest, browser.launch, browser.close.`
      );
      fileLog("dispatch.error", err.error);
      return err;
    }
  }
}

// ─── Main stdin/stdout entry point ───────────────────────────────────────────

async function main(): Promise<void> {
  fileLog("plugin.start", { pid: process.pid, cwd: process.cwd() });
  let rawInput = "";

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  rawInput = rawInput.trim();

  if (!rawInput) {
    process.stdout.write(
      JSON.stringify(makeError("empty_input", "No input received on stdin")) + "\n"
    );
    return;
  }

  let envelope: PluginEnvelope | null = null;
  try {
    envelope = JSON.parse(rawInput) as PluginEnvelope;
  } catch {
    const lines = rawInput.split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      process.stdout.write(
        JSON.stringify(makeError("parse_error", "Failed to parse JSON input")) + "\n"
      );
      return;
    }
    try {
      envelope = JSON.parse(lines[0]!) as PluginEnvelope;
    } catch {
      process.stdout.write(
        JSON.stringify(makeError("parse_error", "Failed to parse JSON input")) + "\n"
      );
      return;
    }
  }

  try {
    const response = await dispatch(envelope);
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (e: unknown) {
    if (e instanceof ProviderError) {
      fileLog("dispatch.error", { code: e.code, message: e.message });
      process.stdout.write(JSON.stringify(makeError(e.code, e.message)) + "\n");
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    fileLog("dispatch.error", { code: "command_failed", message: msg });
    process.stdout.write(
      JSON.stringify(makeError("command_failed", `Unhandled error: ${msg}`)) + "\n"
    );
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stdout.write(
    JSON.stringify({
      protocol: "agent-browser.plugin.v1",
      success: false,
      error: { code: "fatal", message: msg },
    }) + "\n"
  );
  process.exit(1);
});
