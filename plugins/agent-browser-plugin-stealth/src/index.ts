#!/usr/bin/env node
/**
 * agent-browser-plugin-stealth
 * launch.mutate plugin for agent-browser
 *
 * Appends stealth-related Chrome launch args, extensions, initScripts,
 * and userAgent to local Chrome launches via agent-browser.
 *
 * Protocol: agent-browser.plugin.v1 (stdin/stdout JSON)
 *
 * NOTE: This plugin only affects local agent-browser launch.
 * It does NOT modify browsers started via --cdp, --auto-connect, or browser.provider.
 */

import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginEnvelope<TRequest = unknown> {
  protocol?: string;
  type: string;
  capability?: string;
  request?: TRequest;
  id?: string;
  // Legacy issue format
  launch?: { args?: string[] };
}

interface PluginSuccessResponse {
  protocol: "agent-browser.plugin.v1";
  success: true;
  [key: string]: unknown;
}

interface PluginErrorResponse {
  protocol: "agent-browser.plugin.v1";
  success: false;
  error: { code: string; message: string };
}

interface PluginManifestResponse extends PluginSuccessResponse {
  manifest: {
    name: string;
    capabilities: string[];
    description: string;
  };
}

interface LaunchConfig {
  args: string[];
  extensions: string[];
  initScripts: string[];
  userAgent: string;
}

interface LaunchMutateRequest {
  args?: string[];
  extensions?: string[];
  initScripts?: string[];
  userAgent?: string;
}

interface LaunchMutateResponse extends PluginSuccessResponse {
  launch: LaunchConfig;
}

// Legacy response (when id is present)
interface LegacyLaunchMutateResponse {
  id: string;
  launch: LaunchConfig;
}

type PluginResponse =
  | PluginManifestResponse
  | LaunchMutateResponse
  | PluginErrorResponse;

// ---------------------------------------------------------------------------
// Stderr helper
// ---------------------------------------------------------------------------

function stderr(msg: string): void {
  process.stderr.write(`[agent-browser-plugin-stealth] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function makeError(code: string, message: string): PluginErrorResponse {
  return {
    protocol: "agent-browser.plugin.v1",
    success: false,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return homedir() + p.slice(1);
  }
  return p;
}

function resolvePath(p: string): string {
  return resolve(expandHome(p));
}

// ---------------------------------------------------------------------------
// Stealth args
// ---------------------------------------------------------------------------

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
];

function getStealthArgs(existingArgs: string[]): string[] {
  // Start with existing args
  const argSet = new Set(existingArgs);

  // Append stealth args, deduplicating by exact string match
  for (const arg of STEALTH_ARGS) {
    argSet.add(arg);
  }

  // Check for --no-sandbox via env var
  const noSandboxEnv = process.env["AGENT_BROWSER_STEALTH_NO_SANDBOX"];
  if (noSandboxEnv === "1" || noSandboxEnv === "true") {
    stderr(
      "WARNING: --no-sandbox enabled via AGENT_BROWSER_STEALTH_NO_SANDBOX. This reduces browser security."
    );
    argSet.add("--no-sandbox");
  }

  // Extra args from env var (comma or newline separated)
  const extraArgsEnv = process.env["AGENT_BROWSER_STEALTH_ARGS"];
  if (extraArgsEnv) {
    const extraArgs = extraArgsEnv
      .split(/[,\n]/)
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    for (const a of extraArgs) {
      argSet.add(a);
    }
  }

  return Array.from(argSet);
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

function getExtensions(): string[] {
  const extensions: string[] = [];

  // Single extension path
  const singleExt = process.env["AGENT_BROWSER_STEALTH_EXTENSION"];
  if (singleExt) {
    const absPath = resolvePath(singleExt);
    if (!absPath.startsWith("/")) {
      stderr(
        `WARNING: AGENT_BROWSER_STEALTH_EXTENSION must be an absolute path, got: ${singleExt}`
      );
    } else if (!existsSync(absPath)) {
      stderr(
        `WARNING: AGENT_BROWSER_STEALTH_EXTENSION path does not exist: ${absPath}`
      );
    } else {
      extensions.push(absPath);
    }
  }

  // Multiple extension paths
  const multiExt = process.env["AGENT_BROWSER_STEALTH_EXTENSIONS"];
  if (multiExt) {
    const paths = multiExt
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    for (const p of paths) {
      const absPath = resolvePath(p);
      if (!absPath.startsWith("/")) {
        stderr(
          `WARNING: AGENT_BROWSER_STEALTH_EXTENSIONS entry must be an absolute path, got: ${p}`
        );
      } else if (!existsSync(absPath)) {
        stderr(
          `WARNING: AGENT_BROWSER_STEALTH_EXTENSIONS path does not exist: ${absPath}`
        );
      } else {
        extensions.push(absPath);
      }
    }
  }

  // Deduplicate
  return Array.from(new Set(extensions));
}

// ---------------------------------------------------------------------------
// initScripts — minimal generic stealth scripts
// ---------------------------------------------------------------------------

const INIT_SCRIPTS: string[] = [
  // Hide navigator.webdriver
  `(function() {
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: function() { return undefined; },
      configurable: true
    });
  } catch(e) {}
})();`,

  // Provide minimal window.chrome.runtime shape to avoid empty chrome detection
  `(function() {
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        writable: true,
        configurable: true
      });
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  } catch(e) {}
})();`,

  // Suppress automation-related CDP artifact (navigator.languages is read-only in some browsers)
  `(function() {
  try {
    // Ensure plugins array looks non-empty (basic check)
    if (navigator.plugins && navigator.plugins.length === 0) {
      // Don't override — modifying plugins directly can break pages.
      // Just a no-op; automation-aware sites will detect empty plugins in headless mode regardless.
    }
  } catch(e) {}
})();`,
];

// ---------------------------------------------------------------------------
// userAgent
// ---------------------------------------------------------------------------

function getUserAgent(): string {
  const envUA = process.env["AGENT_BROWSER_STEALTH_USER_AGENT"];
  if (envUA && envUA.trim()) {
    return envUA.trim();
  }
  // Return empty string; agent-browser will use its own default
  // We deliberately do NOT hardcode a UA here to avoid platform fingerprint mismatch
  return "";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleManifest(): PluginManifestResponse {
  return {
    protocol: "agent-browser.plugin.v1",
    success: true,
    manifest: {
      name: "agent-browser-plugin-stealth",
      capabilities: ["launch.mutate"],
      description:
        "Append local Chrome launch args, extensions, init scripts, and userAgent overrides for stealth automation.",
    },
  };
}

function handleLaunchMutate(req: LaunchMutateRequest): LaunchMutateResponse {
  const existingArgs = req.args ?? [];
  const args = getStealthArgs(existingArgs);
  const extensions = getExtensions();
  const initScripts = INIT_SCRIPTS;
  const userAgent = getUserAgent();

  return {
    protocol: "agent-browser.plugin.v1",
    success: true,
    launch: {
      args,
      extensions,
      initScripts,
      userAgent,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function dispatch(envelope: PluginEnvelope): PluginResponse {
  const isOfficial = envelope.protocol === "agent-browser.plugin.v1";
  const isLegacy = !envelope.protocol;

  if (!isOfficial && !isLegacy) {
    return makeError(
      "unsupported_protocol",
      `Unsupported protocol: "${String(envelope.protocol)}". Expected "agent-browser.plugin.v1".`
    );
  }

  switch (envelope.type) {
    case "plugin.manifest":
      return handleManifest();

    case "launch.mutate": {
      // Official envelope: request is in envelope.request
      // Legacy format: args may be in envelope.launch.args
      let req: LaunchMutateRequest = {};
      if (isOfficial && envelope.request) {
        req = envelope.request as LaunchMutateRequest;
      } else if (isLegacy && envelope.launch) {
        req = { args: envelope.launch.args ?? [] };
      }
      return handleLaunchMutate(req);
    }

    default:
      return makeError(
        "unsupported_type",
        `Unsupported request type: "${String(envelope.type)}". Supported types: plugin.manifest, launch.mutate.`
      );
  }
}

// ---------------------------------------------------------------------------
// stdin/stdout entry point — NDJSON support for multi-line test compat
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let rawInput = "";

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    rawInput += chunk as string;
  }

  rawInput = rawInput.trim();

  if (!rawInput) {
    process.stdout.write(
      JSON.stringify(makeError("empty_input", "No input received on stdin")) +
        "\n"
    );
    return;
  }

  // Try single JSON first (official path - one request, one response)
  try {
    const envelope = JSON.parse(rawInput) as PluginEnvelope;
    const response = dispatch(envelope);

    // If legacy with id, wrap differently
    if (!envelope.protocol && envelope.id) {
      const legacyResp: Record<string, unknown> = {
        id: envelope.id,
      };
      if (response.success === false) {
        legacyResp["error"] = (response as PluginErrorResponse).error;
      } else if ("launch" in response) {
        legacyResp["launch"] = (response as LaunchMutateResponse).launch;
      } else {
        // manifest or other - pass through as-is
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }
      process.stdout.write(JSON.stringify(legacyResp) + "\n");
      return;
    }

    process.stdout.write(JSON.stringify(response) + "\n");
    return;
  } catch {
    // Not valid single JSON — try NDJSON
  }

  // NDJSON fallback (for direct testing with multiple requests)
  const lines = rawInput.split("\n").filter((l) => l.trim());
  if (lines.length > 1) {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const envelope = JSON.parse(line) as PluginEnvelope;
        const response = dispatch(envelope);

        if (!envelope.protocol && envelope.id) {
          const legacyResp: Record<string, unknown> = { id: envelope.id };
          if (response.success === false) {
            legacyResp["error"] = (response as PluginErrorResponse).error;
          } else if ("launch" in response) {
            legacyResp["launch"] = (response as LaunchMutateResponse).launch;
          } else {
            process.stdout.write(JSON.stringify(response) + "\n");
            continue;
          }
          process.stdout.write(JSON.stringify(legacyResp) + "\n");
        } else {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(
          JSON.stringify(makeError("parse_error", `JSON parse error: ${msg}`)) + "\n"
        );
      }
    }
    return;
  }

  // Single line that couldn't parse
  process.stdout.write(
    JSON.stringify(
      makeError("parse_error", `Failed to parse JSON input: ${rawInput.substring(0, 100)}`)
    ) + "\n"
  );
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
