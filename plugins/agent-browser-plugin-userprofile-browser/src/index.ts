#!/usr/bin/env node
/**
 * agent-browser-plugin-userprofile-browser
 * browser.provider plugin for agent-browser
 *
 * Launches or connects to a local Chrome instance with a user profile,
 * returning the CDP URL for agent-browser to consume.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir, platform } from "os";
import { join, resolve } from "path";
import { createServer } from "net";
import { request as httpRequest } from "http";

// ─── Protocol Types ──────────────────────────────────────────────────────────

interface PluginEnvelope<TRequest = unknown> {
  protocol: string;
  type: string;
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

interface BrowserMetadata {
  userDataDir: string;
  profileDirectory: string;
  mode: "launch" | "connect";
  sessionId: string;
  executablePath?: string;
  port?: number;
}

interface BrowserCleanup {
  sessionId: string;
}

interface BrowserProviderResponse extends PluginSuccessResponse {
  browser: {
    cdpUrl: string;
    directPage: boolean;
    metadata: BrowserMetadata;
    cleanup?: BrowserCleanup;
  };
}

interface BrowserLaunchRequest {
  profileDirectory?: string;
  userDataDir?: string;
  executablePath?: string;
  cdpUrl?: string;
  port?: number;
  args?: string[];
}

interface BrowserCloseRequest {
  sessionId?: string;
  cleanup?: { sessionId?: string };
}

type PluginResponse = PluginManifestResponse | BrowserProviderResponse | { protocol: "agent-browser.plugin.v1"; success: true; data: { closed: boolean; noOp?: boolean } } | PluginErrorResponse;

// ─── Session Registry ─────────────────────────────────────────────────────────

interface Session {
  sessionId: string;
  mode: "launch" | "connect";
  process?: ChildProcess;
  pid?: number;
  port?: number;
  cdpUrl: string;
  userDataDir: string;
  profileDirectory: string;
}

const sessions = new Map<string, Session>();

// ─── Utility: expand ~ in paths ───────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function resolvePath(p: string): string {
  return resolve(expandHome(p));
}

// ─── Utility: find an available TCP port ──────────────────────────────────────

async function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return rej(new Error("Cannot get port"));
      const port = addr.port;
      srv.close(() => res(port));
    });
    srv.on("error", rej);
  });
}

// ─── Utility: HTTP GET returning body text ────────────────────────────────────

async function httpGet(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((res, rej) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : 80,
        path: parsed.pathname + parsed.search,
        method: "GET",
        timeout: timeoutMs,
      },
      (resp) => {
        let data = "";
        resp.on("data", (chunk: Buffer) => (data += chunk.toString()));
        resp.on("end", () => res(data));
      }
    );
    req.on("error", rej);
    req.on("timeout", () => {
      req.destroy();
      rej(new Error(`HTTP GET ${url} timed out`));
    });
    req.end();
  });
}

// ─── Utility: poll /json/version ─────────────────────────────────────────────

async function pollJsonVersion(
  port: number,
  maxWaitMs = 15000,
  intervalMs = 300
): Promise<string> {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const body = await httpGet(url, intervalMs + 100);
      const json = JSON.parse(body) as { webSocketDebuggerUrl?: string };
      if (json.webSocketDebuggerUrl) {
        return json.webSocketDebuggerUrl;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Chrome CDP not available on port ${port} after ${maxWaitMs}ms`);
}

// ─── Utility: read DevToolsActivePort file ───────────────────────────────────

async function readDevToolsActivePort(userDataDir: string, maxWaitMs = 10000): Promise<number> {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const content = await readFile(portFile, "utf8");
      const lines = content.trim().split("\n");
      const port = parseInt(lines[0]!, 10);
      if (!isNaN(port) && port > 0) {
        return port;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DevToolsActivePort file not found in ${userDataDir} after ${maxWaitMs}ms`);
}

// ─── Chrome Profile Detection ─────────────────────────────────────────────────

interface ProfileConfig {
  userDataDir: string;
  profileDirectory: string;
}

function getDefaultUserDataDir(): string {
  const plat = platform();
  if (plat === "darwin") {
    return expandHome("~/Library/Application Support/Google/Chrome");
  }
  // Linux
  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? expandHome("~/.config");
  const googleChrome = join(xdgConfig, "google-chrome");
  if (existsSync(googleChrome)) {
    return googleChrome;
  }
  const chromium = join(xdgConfig, "chromium");
  if (existsSync(chromium)) {
    return chromium;
  }
  // fallback even if doesn't exist yet
  return googleChrome;
}

function resolveProfileConfig(req?: BrowserLaunchRequest): ProfileConfig {
  // Env var overrides
  const envDir =
    process.env["AGENT_BROWSER_USERPROFILE_DIR"] ??
    process.env["AGENT_BROWSER_USERPROFILE_NAME"];
  const envProfileDir = process.env["AGENT_BROWSER_PROFILE_DIRECTORY"];

  const rawDir = req?.userDataDir ?? envDir ?? getDefaultUserDataDir();
  const rawProfileDir = req?.profileDirectory ?? envProfileDir ?? "Default";

  const userDataDir = resolvePath(rawDir);
  const profileDirectory = rawProfileDir; // e.g. "Default", "Profile 1"

  return { userDataDir, profileDirectory };
}

// ─── Chrome Executable Detection ─────────────────────────────────────────────

const macOSChromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const linuxChromeNames = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

function whichSync(name: string): string | null {
  try {
    const result = execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function findChrome(req?: BrowserLaunchRequest): string | null {
  if (req?.executablePath) return resolvePath(req.executablePath);
  if (process.env["CHROME_PATH"]) return resolvePath(process.env["CHROME_PATH"]);

  const plat = platform();
  if (plat === "darwin") {
    if (existsSync(macOSChromePath)) return macOSChromePath;
    // Try using 'which' for any installed chrome
    const found = whichSync("google-chrome") ?? whichSync("chromium");
    return found;
  }

  // Linux
  for (const name of linuxChromeNames) {
    const found = whichSync(name);
    if (found) return found;
  }
  return null;
}

// ─── Chrome Lock Detection ────────────────────────────────────────────────────

function isProfileLocked(userDataDir: string): boolean {
  // Chrome creates a "SingletonLock" symlink on Linux, and uses a lock file on macOS
  const singletonLock = join(userDataDir, "SingletonLock");
  const singletonSocket = join(userDataDir, "SingletonSocket");
  const lockFile = join(userDataDir, "lockfile");

  return existsSync(singletonLock) || existsSync(singletonSocket) || existsSync(lockFile);
}

// ─── Browser.launch Implementation ───────────────────────────────────────────

async function handleBrowserLaunch(
  req: BrowserLaunchRequest,
  id?: string
): Promise<PluginResponse> {
  const { userDataDir, profileDirectory } = resolveProfileConfig(req);

  // 1. If cdpUrl is provided, try to connect to existing Chrome
  const reqCdpUrl = req.cdpUrl ?? process.env["AGENT_BROWSER_CDP_URL"];
  if (reqCdpUrl) {
    try {
      // Validate connectivity - the URL should be ws:// or we can probe http
      const wsUrl = reqCdpUrl;
      const sessionId = `userprofile-connect-${Date.now()}`;
      const session: Session = {
        sessionId,
        mode: "connect",
        cdpUrl: wsUrl,
        userDataDir,
        profileDirectory,
      };
      sessions.set(sessionId, session);

      const response: BrowserProviderResponse = {
        protocol: "agent-browser.plugin.v1",
        success: true,
        browser: {
          cdpUrl: wsUrl,
          directPage: false,
          metadata: {
            userDataDir,
            profileDirectory,
            mode: "connect",
            sessionId,
          },
        },
      };
      if (id) (response as unknown as Record<string, unknown>)["id"] = id;
      return response;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return makeError("connect_failed", `Failed to connect to cdpUrl: ${msg}`);
    }
  }

  // 2. If port provided, try to connect via existing remote debugging
  if (req.port) {
    try {
      const cdpUrl = await pollJsonVersion(req.port, 3000);
      const sessionId = `userprofile-connect-port-${req.port}-${Date.now()}`;
      const session: Session = {
        sessionId,
        mode: "connect",
        port: req.port,
        cdpUrl,
        userDataDir,
        profileDirectory,
      };
      sessions.set(sessionId, session);

      const response: BrowserProviderResponse = {
        protocol: "agent-browser.plugin.v1",
        success: true,
        browser: {
          cdpUrl,
          directPage: false,
          metadata: {
            userDataDir,
            profileDirectory,
            mode: "connect",
            sessionId,
            port: req.port,
          },
        },
      };
      if (id) (response as unknown as Record<string, unknown>)["id"] = id;
      return response;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      stderr(`Port connect attempt failed: ${msg}`);
    }
  }

  // 3. Check if profile is locked (another Chrome already running with this profile)
  if (isProfileLocked(userDataDir)) {
    // Try to find a remote debugging port from an existing Chrome via typical ports
    for (const tryPort of [9222, 9223, 9224, 9225]) {
      try {
        const cdpUrl = await pollJsonVersion(tryPort, 2000);
        stderr(`Found existing Chrome on port ${tryPort}, connecting`);
        const sessionId = `userprofile-connect-existing-${tryPort}-${Date.now()}`;
        const session: Session = {
          sessionId,
          mode: "connect",
          port: tryPort,
          cdpUrl,
          userDataDir,
          profileDirectory,
        };
        sessions.set(sessionId, session);

        const response: BrowserProviderResponse = {
          protocol: "agent-browser.plugin.v1",
          success: true,
          browser: {
            cdpUrl,
            directPage: false,
            metadata: {
              userDataDir,
              profileDirectory,
              mode: "connect",
              sessionId,
              port: tryPort,
            },
          },
        };
        if (id) (response as unknown as Record<string, unknown>)["id"] = id;
        return response;
      } catch {
        // keep trying
      }
    }

    return makeError(
      "profile_locked",
      `Chrome profile at "${userDataDir}" (${profileDirectory}) is locked by a running Chrome instance. ` +
        "Close Chrome or provide a cdpUrl/port to connect to the existing session."
    );
  }

  // 4. Launch a new Chrome
  const chromePath = findChrome(req);
  if (!chromePath) {
    return makeError(
      "chrome_not_found",
      "Chrome executable not found. Set CHROME_PATH or pass executablePath in the request."
    );
  }

  let debugPort: number;
  try {
    debugPort = await findFreePort();
  } catch {
    debugPort = 9222;
  }

  const coreArgs: string[] = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    `--remote-debugging-port=${debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Merge extra args, deduplicating by flag name
  const extraArgs = (req.args ?? []).filter((a) => {
    const flagName = a.split("=")[0];
    if (!flagName) return false;
    // Skip if core args already set this flag
    return !coreArgs.some((core) => core.startsWith(flagName + "=") || core === flagName);
  });

  const allArgs = [...coreArgs, ...extraArgs];

  stderr(`Launching Chrome: ${chromePath} ${allArgs.join(" ")}`);

  const chromeProcess = spawn(chromePath, allArgs, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Log chrome stderr to our stderr
  chromeProcess.stderr?.on("data", (data: Buffer) => {
    stderr(`[chrome] ${data.toString().trim()}`);
  });

  if (!chromeProcess.pid) {
    return makeError("launch_failed", "Failed to spawn Chrome process");
  }

  const pid = chromeProcess.pid;
  const sessionId = `userprofile-launch-${pid}-${Date.now()}`;

  // Wait for Chrome to be ready
  let cdpUrl: string;
  try {
    // Try DevToolsActivePort file first
    let port = debugPort;
    try {
      port = await readDevToolsActivePort(userDataDir, 8000);
    } catch {
      stderr(`DevToolsActivePort not available, using port ${debugPort}`);
    }
    cdpUrl = await pollJsonVersion(port, 15000);
    debugPort = port;
  } catch (e: unknown) {
    // Try to kill the spawned process
    try { chromeProcess.kill(); } catch { /* ignore */ }
    const msg = e instanceof Error ? e.message : String(e);
    return makeError("launch_timeout", `Chrome failed to start: ${msg}`);
  }

  const session: Session = {
    sessionId,
    mode: "launch",
    process: chromeProcess,
    pid,
    port: debugPort,
    cdpUrl,
    userDataDir,
    profileDirectory,
  };
  sessions.set(sessionId, session);

  // Handle unexpected process exit
  chromeProcess.on("exit", (code) => {
    stderr(`Chrome (session ${sessionId}) exited with code ${code}`);
    sessions.delete(sessionId);
  });

  const response: BrowserProviderResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    browser: {
      cdpUrl,
      directPage: false,
      metadata: {
        userDataDir,
        profileDirectory,
        mode: "launch",
        sessionId,
        executablePath: chromePath,
        port: debugPort,
      },
      cleanup: {
        sessionId,
      },
    },
  };
  if (id) (response as unknown as Record<string, unknown>)["id"] = id;
  return response;
}

// ─── Browser.close Implementation ─────────────────────────────────────────────

function handleBrowserClose(req: BrowserCloseRequest, id?: string): PluginResponse {
  const sessionId = req.sessionId ?? req.cleanup?.sessionId;
  const protocol = "agent-browser.plugin.v1" as const;

  if (!sessionId) {
    return {
      protocol,
      success: true,
      data: { closed: false, noOp: true },
    };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    // Idempotent: already closed or unknown session
    return {
      protocol,
      success: true,
      data: { closed: false, noOp: true },
    };
  }

  if (session.mode === "launch" && session.process) {
    try {
      session.process.kill("SIGTERM");
      // If still running after a bit, force kill
      setTimeout(() => {
        try { session.process?.kill("SIGKILL"); } catch { /* ignore */ }
      }, 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      stderr(`Error killing Chrome process: ${msg}`);
    }
  } else if (session.mode === "connect") {
    stderr(`Session ${sessionId} was connect-mode; not closing user Chrome`);
  }

  sessions.delete(sessionId);

  const response = {
    protocol,
    success: true as const,
    data: { closed: true },
  };
  if (id) (response as unknown as Record<string, unknown>)["id"] = id;
  return response;
}

// ─── Plugin.manifest Implementation ──────────────────────────────────────────

function handleManifest(): PluginManifestResponse {
  return {
    protocol: "agent-browser.plugin.v1",
    success: true,
    manifest: {
      name: "agent-browser-plugin-userprofile-browser",
      capabilities: ["browser.provider"],
      description:
        "Launch or connect Chrome with a selected user profile for agent-browser.",
    },
  };
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function makeError(code: string, message: string): PluginErrorResponse {
  return {
    protocol: "agent-browser.plugin.v1",
    success: false,
    error: { code, message },
  };
}

// ─── Stderr helper (safe) ─────────────────────────────────────────────────────

function stderr(msg: string): void {
  process.stderr.write(`[agent-browser-plugin-userprofile-browser] ${msg}\n`);
}

// ─── Request Dispatch ─────────────────────────────────────────────────────────

async function dispatch(envelope: PluginEnvelope): Promise<PluginResponse> {
  const { type, request, id } = envelope;

  // Check protocol for official requests; allow legacy (no protocol field) through compat branch
  const isOfficial = envelope.protocol === "agent-browser.plugin.v1";
  const isLegacy = !envelope.protocol;

  if (!isOfficial && !isLegacy) {
    return makeError(
      "unsupported_protocol",
      `Unsupported protocol: ${String(envelope.protocol)}. Expected "agent-browser.plugin.v1".`
    );
  }

  switch (type) {
    case "plugin.manifest":
      return handleManifest();

    case "browser.launch":
      return await handleBrowserLaunch((request as BrowserLaunchRequest) ?? {}, id);

    case "browser.close":
      return handleBrowserClose((request as BrowserCloseRequest) ?? {}, id);

    default:
      return makeError(
        "unsupported_type",
        `Unsupported request type: "${String(type)}". Supported types: plugin.manifest, browser.launch, browser.close.`
      );
  }
}

// ─── Main stdin/stdout entry point ───────────────────────────────────────────

async function main(): Promise<void> {
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

  // Try single JSON first (official path)
  let envelope: PluginEnvelope | null = null;
  try {
    envelope = JSON.parse(rawInput) as PluginEnvelope;
  } catch {
    // If single JSON fails, try NDJSON (for direct script testing compat)
    const lines = rawInput.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      // Process only first line for compatibility; agent-browser path always single JSON
      try {
        envelope = JSON.parse(lines[0]!) as PluginEnvelope;
      } catch {
        process.stdout.write(
          JSON.stringify(makeError("parse_error", "Failed to parse JSON input")) + "\n"
        );
        return;
      }
    } else {
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
