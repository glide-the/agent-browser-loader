#!/usr/bin/env node
/**
 * agent-browser-plugin-userprofile-browser
 * launch.mutate plugin for agent-browser
 *
 * Appends Chrome user profile launch arguments to local agent-browser launches.
 * This keeps extension loading on the local-browser path instead of using
 * --provider, which cannot be combined with --extension.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir, platform } from "os";
import { join, resolve } from "path";

// ─── Protocol Types ──────────────────────────────────────────────────────────

interface PluginEnvelope<TRequest = unknown> {
  protocol?: string;
  type?: string;
  capability?: string;
  request?: TRequest;
  launch?: Partial<LaunchMutateRequest>;
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

interface LaunchMutateRequest {
  args?: string[];
  extensions?: string[];
  initScripts?: string[];
  userAgent?: string;
  userDataDir?: string;
  profileDirectory?: string;
}

interface LaunchMutateResponse extends PluginSuccessResponse {
  launch: {
    args: string[];
    extensions: string[];
    initScripts: string[];
    userAgent: string;
  };
}

type PluginResponse = PluginManifestResponse | LaunchMutateResponse | PluginErrorResponse;

interface ProfileConfig {
  userDataDir: string;
  profileDirectory: string;
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
    process.stderr.write(`[agent-browser-plugin-userprofile-browser][fileLog error] could not write to ${LOG_FILE}\n`);
  }
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

function resolveProfileConfig(req?: LaunchMutateRequest): ProfileConfig {
  const envDir =
    process.env["AGENT_BROWSER_USERPROFILE_DIR"] ??
    process.env["AGENT_BROWSER_USERPROFILE_NAME"];
  const envProfileDir = process.env["AGENT_BROWSER_PROFILE_DIRECTORY"];

  const rawDir = req?.userDataDir ?? envDir ?? getDefaultUserDataDir();
  const rawProfileDir = req?.profileDirectory ?? envProfileDir ?? "Default";

  return {
    userDataDir: resolvePath(rawDir),
    profileDirectory: rawProfileDir,
  };
}

// ─── Launch Argument Mutation ─────────────────────────────────────────────────

function arrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function argFlagName(arg: string): string | null {
  if (!arg.startsWith("--")) {
    return null;
  }
  const eqIndex = arg.indexOf("=");
  return eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
}

function hasArg(args: string[], candidate: string): boolean {
  const candidateFlag = argFlagName(candidate);
  if (!candidateFlag) {
    return args.includes(candidate);
  }
  return args.some((arg) => {
    const flag = argFlagName(arg);
    return flag === candidateFlag;
  });
}

function appendMissingArgs(existingArgs: string[], profile: ProfileConfig): string[] {
  const desiredArgs = [
    `--user-data-dir=${profile.userDataDir}`,
    `--profile-directory=${profile.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const args = [...existingArgs];
  for (const arg of desiredArgs) {
    if (!hasArg(args, arg)) {
      args.push(arg);
    }
  }
  return args;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleManifest(): PluginManifestResponse {
  fileLog("handle.manifest");
  const resp: PluginManifestResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    manifest: {
      name: "agent-browser-plugin-userprofile-browser",
      capabilities: ["launch.mutate"],
      description:
        "Append Chrome user profile launch args so local agent-browser launches can reuse a selected profile.",
    },
  };
  fileLog("handle.manifest.response", { manifest: resp.manifest });
  return resp;
}

function handleLaunchMutate(req: LaunchMutateRequest, id?: string): LaunchMutateResponse {
  const profile = resolveProfileConfig(req);
  const existingArgs = arrayOrEmpty(req.args);
  const extensions = arrayOrEmpty(req.extensions);
  const initScripts = arrayOrEmpty(req.initScripts);
  const userAgent = typeof req.userAgent === "string" ? req.userAgent : "";

  fileLog("handle.launchMutate.request", {
    argsCount: existingArgs.length,
    extensionsCount: extensions.length,
    initScriptsCount: initScripts.length,
    hasUserAgent: Boolean(userAgent),
    profileDirectory: profile.profileDirectory,
  });

  const resp: LaunchMutateResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    launch: {
      args: appendMissingArgs(existingArgs, profile),
      extensions,
      initScripts,
      userAgent,
    },
  };

  if (id) {
    (resp as unknown as Record<string, unknown>)["id"] = id;
  }

  fileLog("handle.launchMutate.response", {
    argsCount: resp.launch.args.length,
    extensionsCount: resp.launch.extensions.length,
    initScriptsCount: resp.launch.initScripts.length,
    profileDirectory: profile.profileDirectory,
  });

  return resp;
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

  fileLog("dispatch.request", { type: envelope.type, protocol: envelope.protocol ?? "legacy", id: envelope.id });

  if (!isOfficial && !isLegacy) {
    const err = makeError(
      "unsupported_protocol",
      `Unsupported protocol: ${String(envelope.protocol)}. Expected "agent-browser.plugin.v1".`
    );
    fileLog("dispatch.error", err.error);
    return err;
  }

  switch (envelope.type) {
    case "plugin.manifest":
      return handleManifest();

    case "launch.mutate": {
      const req = (isOfficial ? envelope.request : envelope.launch) ?? {};
      return handleLaunchMutate(req as LaunchMutateRequest, envelope.id);
    }

    default: {
      const err = makeError(
        "unsupported_type",
        `Unsupported request type: "${String(envelope.type)}". Supported types: plugin.manifest, launch.mutate.`
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
