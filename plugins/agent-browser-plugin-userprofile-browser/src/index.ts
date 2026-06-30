#!/usr/bin/env node
/**
 * agent-browser-plugin-userprofile-browser
 * command.run plugin for agent-browser
 *
 * Performs a ONE-TIME full rsync of the real Chrome profile into a separate
 * "RemoteDebug" user-data-dir — bypassing the "non-default data directory"
 * detection used by some anti-bot sites — then persists the resolved
 * user-data-dir / profile-directory to a local state file so that the
 * agent-browser-plugin-stealth launch.mutate plugin can inject
 * --user-data-dir / --profile-directory WITHOUT re-running the heavy sync on
 * every local launch.
 *
 * Capability: command.run
 * Request types (invoked via `agent-browser plugin run <name> <type>`):
 *   - browser.launch : rsync profile + persist state, returns { data }
 *   - browser.close  : remove persisted state, returns { data }
 *
 * Protocol: agent-browser.plugin.v1 (stdin/stdout JSON)
 *
 * This plugin never starts or kills Chrome and never deletes profile lock
 * files; it only syncs profile data and records the launch directory.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { homedir, platform } from "os";
import { basename, dirname, join, resolve } from "path";

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

type PluginResponse =
  | PluginManifestResponse
  | CommandRunResponse
  | PluginErrorResponse;

interface BrowserLaunchRequest {
  /** Source Chrome user-data-dir to copy FROM (the real profile). */
  userDataDir?: string;
  /** Profile sub-directory name, e.g. "Default". */
  profileDirectory?: string;
  /** Target "RemoteDebug" user-data-dir to copy TO and launch FROM. */
  debugDir?: string;
  /** Force re-sync even if a state file already exists. */
  force?: boolean;
}

interface BrowserCloseRequest {
  /** Remove the synced debug directory in addition to the state file. */
  removeDebugDir?: boolean;
}

interface ProfileState {
  userDataDir: string;
  profileDirectory: string;
  source: string;
  syncedAt: string;
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

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleManifest(): PluginManifestResponse {
  fileLog("handle.manifest");
  const resp: PluginManifestResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    manifest: {
      name: "userprofile-browser",
      capabilities: ["command.run"],
      description:
        "One-time rsync of the real Chrome profile into a RemoteDebug user-data-dir, persisting the launch directory for the stealth launch.mutate plugin to consume.",
    },
  };
  fileLog("handle.manifest.response", { manifest: resp.manifest });
  return resp;
}

function handleBrowserLaunch(req: BrowserLaunchRequest): CommandRunResponse {
  const config = readConfig();
  const statePath = getStatePath(config);
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

  fileLog("handle.browserLaunch.request", {
    source,
    profileDirectory,
    debugDir,
    force,
  });

  const existing = readState(statePath);
  let synced = false;
  let skippedReason: string | null = null;

  if (existing && !force) {
    // Already prepared once — the rsync is intentionally NOT re-run on every
    // call to keep this a one-time operation. Pass force:true to refresh.
    skippedReason = "already-synced";
    stderr(`State already exists; skipping rsync (pass force:true to re-sync).`);
  } else {
    if (!existsSync(join(source, profileDirectory))) {
      const err = `Source profile not found: ${join(source, profileDirectory)}`;
      fileLog("handle.browserLaunch.error", { message: err });
      throw new Error(err);
    }
    syncProfile(join(source, profileDirectory), join(debugDir, profileDirectory));
    synced = true;
  }

  const state: ProfileState = {
    userDataDir: debugDir,
    profileDirectory,
    source,
    syncedAt: new Date().toISOString(),
  };
  writeState(state, statePath);

  const data: Record<string, unknown> = {
    userDataDir: debugDir,
    profileDirectory,
    source,
    synced,
    statePath,
  };
  if (skippedReason) {
    data["skipped"] = skippedReason;
  }

  fileLog("handle.browserLaunch.response", data);
  return { protocol: "agent-browser.plugin.v1", success: true, data };
}

function handleBrowserClose(req: BrowserCloseRequest): CommandRunResponse {
  fileLog("handle.browserClose.request", { removeDebugDir: req.removeDebugDir === true });

  const config = readConfig();
  const statePath = getStatePath(config);
  const state = readState(statePath);
  const removedState = removeState(statePath);

  let removedDebugDir = false;
  if (req.removeDebugDir === true && state && existsSync(state.userDataDir)) {
    rmSync(state.userDataDir, { recursive: true, force: true });
    removedDebugDir = true;
  }

  const data: Record<string, unknown> = {
    closed: true,
    removedState,
    removedDebugDir,
  };
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

function dispatch(envelope: PluginEnvelope): PluginResponse {
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

  try {
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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = makeError("command_failed", msg);
    fileLog("dispatch.error", err.error);
    return err;
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
    const response = dispatch(envelope);
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(
      JSON.stringify(makeError("internal_error", `Unhandled error: ${msg}`)) + "\n"
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
