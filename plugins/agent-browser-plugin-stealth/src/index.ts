#!/usr/bin/env node
/**
 * agent-browser-plugin-stealth
 * launch.mutate plugin for agent-browser
 *
 * Appends stealth-related Chrome launch args, extensions, initScripts,
 * and userAgent to local Chrome launches via agent-browser, and injects
 * real Chrome user-profile args (--user-data-dir / --profile-directory) so
 * the local launch can reuse a logged-in profile while still loading
 * extensions (which the --provider path cannot do).
 *
 * This plugin merges the former agent-browser-plugin-userprofile-browser
 * plugin; both shared the same launch.mutate capability.
 *
 * Protocol: agent-browser.plugin.v1 (stdin/stdout JSON)
 *
 * NOTE: This plugin only affects local agent-browser launch.
 * It does NOT modify browsers started via --cdp, --auto-connect, or browser.provider.
 */

import { existsSync, readdirSync, mkdirSync, appendFileSync } from "fs";
import { resolve, join } from "path";
import { homedir, platform } from "os";

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
  launch?: Partial<LaunchMutateRequest>;
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
  userDataDir?: string;
  profileDirectory?: string;
}

interface ProfileConfig {
  userDataDir: string;
  profileDirectory: string;
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
// File logger — writes JSON-lines to logs/agent-browser-plugin-stealth.log
// under the CWD (agent-browser run directory).
// ---------------------------------------------------------------------------

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "agent-browser-plugin-stealth.log");

function fileLog(event: string, data?: unknown): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      plugin: "agent-browser-plugin-stealth",
      event,
      ...(data !== undefined ? { data } : {}),
    });
    appendFileSync(LOG_FILE, entry + "\n");
  } catch {
    // never throw from logger — only fall back to stderr
    stderr(`[fileLog error] could not write to ${LOG_FILE}`);
  }
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

const DISABLE_BLINK_FEATURES_PREFIX = "--disable-blink-features=";
const AUTOMATION_CONTROLLED_FEATURE = "AutomationControlled";

// Mirrors common stealth/default-arg behavior: remove switches that advertise
// automation or force an extension-disabled browser shape.
const STRIPPED_STEALTH_FLAGS = new Set([
  "--enable-automation",
  "--disable-extensions",
  "--disable-default-apps",
  "--disable-component-extensions-with-background-pages",
]);

function getFlagName(arg: string): string {
  const equalIndex = arg.indexOf("=");
  return equalIndex === -1 ? arg : arg.slice(0, equalIndex);
}

function parseListEnv(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function shouldStripArg(arg: string): boolean {
  return STRIPPED_STEALTH_FLAGS.has(getFlagName(arg));
}

function addUnique(args: string[], arg: string): void {
  if (!args.includes(arg)) {
    args.push(arg);
  }
}

function addAutomationControlledFeature(args: string[]): string[] {
  const output: string[] = [];
  const features: string[] = [];

  for (const arg of args) {
    if (!arg.startsWith(DISABLE_BLINK_FEATURES_PREFIX)) {
      output.push(arg);
      continue;
    }

    const rawFeatures = arg.slice(DISABLE_BLINK_FEATURES_PREFIX.length);
    for (const feature of rawFeatures.split(",")) {
      const trimmed = feature.trim();
      if (trimmed && !features.includes(trimmed)) {
        features.push(trimmed);
      }
    }
  }

  if (!features.includes(AUTOMATION_CONTROLLED_FEATURE)) {
    features.push(AUTOMATION_CONTROLLED_FEATURE);
  }

  output.push(`${DISABLE_BLINK_FEATURES_PREFIX}${features.join(",")}`);
  return output;
}

function getStealthArgs(existingArgs: string[]): string[] {
  const args: string[] = [];
  const strippedArgs: string[] = [];

  for (const arg of existingArgs) {
    if (shouldStripArg(arg)) {
      strippedArgs.push(arg);
      continue;
    }
    addUnique(args, arg);
  }

  if (strippedArgs.length > 0) {
    stderr(`Stripped automation/default Chrome args: ${strippedArgs.join(", ")}`);
  }

  // Check for --no-sandbox via env var
  const noSandboxEnv = process.env["AGENT_BROWSER_STEALTH_NO_SANDBOX"];
  if (noSandboxEnv === "1" || noSandboxEnv === "true") {
    stderr(
      "WARNING: --no-sandbox enabled via AGENT_BROWSER_STEALTH_NO_SANDBOX. This reduces browser security."
    );
    addUnique(args, "--no-sandbox");
  }

  // Extra args from env var (comma or newline separated)
  const extraArgsEnv = process.env["AGENT_BROWSER_STEALTH_ARGS"];
  if (extraArgsEnv) {
    for (const extraArg of parseListEnv(extraArgsEnv)) {
      if (shouldStripArg(extraArg)) {
        stderr(`Skipping stripped stealth arg from AGENT_BROWSER_STEALTH_ARGS: ${extraArg}`);
        continue;
      }
      addUnique(args, extraArg);
    }
  }

  return addAutomationControlledFeature(args);
}

// ---------------------------------------------------------------------------
// Chrome user profile (merged from agent-browser-plugin-userprofile-browser)
// ---------------------------------------------------------------------------

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

function resolveProfileConfig(req: LaunchMutateRequest): ProfileConfig {
  const envDir =
    process.env["AGENT_BROWSER_USERPROFILE_DIR"] ??
    process.env["AGENT_BROWSER_USERPROFILE_NAME"];
  const envProfileDir = process.env["AGENT_BROWSER_PROFILE_DIRECTORY"];

  const rawDir = req.userDataDir ?? envDir ?? getDefaultUserDataDir();
  const rawProfileDir = req.profileDirectory ?? envProfileDir ?? "Default";

  return {
    userDataDir: resolvePath(rawDir),
    profileDirectory: rawProfileDir,
  };
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
  return args.some((arg) => argFlagName(arg) === candidateFlag);
}

function appendProfileArgs(existingArgs: string[], profile: ProfileConfig): string[] {
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

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

function getExtensions(existingExtensions: string[] = []): string[] {
  const extensions: string[] = [...existingExtensions];

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
    const paths = parseListEnv(multiExt);
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
// initScripts - generic stealth scripts adapted to this plugin's initScript
// surface. These are intentionally broad browser-shape fixes, not site-specific
// bypass logic.
// ---------------------------------------------------------------------------

const INIT_SCRIPTS: string[] = [
  `(function() {
  try {
    var navProto = Object.getPrototypeOf(navigator);
    var defineGetter = function(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, { get: getter, configurable: true });
      } catch (e) {}
    };
    var defineValue = function(target, prop, value) {
      try {
        Object.defineProperty(target, prop, {
          value: value,
          writable: true,
          enumerable: true,
          configurable: true
        });
      } catch (e) {
        try { target[prop] = value; } catch (_) {}
      }
    };
    var nativeFunctionToString = Function.prototype.toString;
    var nativeSourceMap = typeof WeakMap === 'function' ? new WeakMap() : null;
    var registerNativeSource = function(fn, source) {
      try {
        if (nativeSourceMap && typeof fn === 'function') {
          nativeSourceMap.set(fn, source);
        }
      } catch (e) {}
    };
    try {
      var patchedToString = function toString() {
        if (nativeSourceMap && nativeSourceMap.has(this)) {
          return nativeSourceMap.get(this);
        }
        return nativeFunctionToString.call(this);
      };
      Object.defineProperty(patchedToString, '__agentBrowserStealthPatched', { value: true });
      registerNativeSource(patchedToString, nativeFunctionToString.call(nativeFunctionToString));
      Object.defineProperty(Function.prototype, 'toString', {
        value: patchedToString,
        writable: true,
        configurable: true
      });
    } catch (e) {}
    var asNative = function(fn, name) {
      var source = 'function ' + name + '() { [native code] }';
      registerNativeSource(fn, source);
      try {
        Object.defineProperty(fn, 'toString', {
          value: function() { return source; },
          configurable: true
        });
      } catch (e) {}
      return fn;
    };
    var replaceMethod = function(target, prop, fn) {
      try {
        var descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (descriptor && descriptor.configurable !== false) {
          Object.defineProperty(target, prop, {
            value: fn,
            writable: descriptor.writable !== false,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable
          });
        } else {
          target[prop] = fn;
        }
      } catch (e) {
        try { target[prop] = fn; } catch (_) {}
      }
    };

    // console.table/performance.now timing probes used by devtools detectors.
    // performance.now must be strictly increasing; some detectors treat t1 === t2
    // as proof that now() was hooked and then trigger destructive branches.
    try {
      if (window.console && typeof console.table === 'function' && !console.table.__agentBrowserStealthAntiDebugPatched) {
        var table = function table() {};
        Object.defineProperty(table, '__agentBrowserStealthAntiDebugPatched', { value: true });
        replaceMethod(console, 'table', asNative(table, 'table'));
      }
    } catch (e) {}
    try {
      if (window.performance && typeof performance.now === 'function' && !performance.now.__agentBrowserStealthAntiDebugPatched) {
        var navStart = typeof performance.timeOrigin === 'number'
          ? performance.timeOrigin
          : (performance.timing && performance.timing.navigationStart) || Date.now();
        var lastMonotonicPerformanceNow = 0;
        var minimumMonotonicStepMs = 0.001;
        var now = function now() {
          var elapsed = Date.now() - navStart;
          if (!isFinite(elapsed)) {
            elapsed = 0;
          }
          if (elapsed <= lastMonotonicPerformanceNow) {
            elapsed = lastMonotonicPerformanceNow + minimumMonotonicStepMs;
          }
          lastMonotonicPerformanceNow = elapsed;
          return elapsed;
        };
        Object.defineProperty(now, '__agentBrowserStealthAntiDebugPatched', { value: true });
        replaceMethod(performance, 'now', asNative(now, 'now'));
      }
    } catch (e) {}

    // navigator.webdriver
    try {
      if (navigator.webdriver !== false && navigator.webdriver !== undefined) {
        delete navProto.webdriver;
      }
      defineGetter(navProto, 'webdriver', function() { return undefined; });
    } catch (e) {}

    // User agent cleanup when a headless UA leaks before agent-browser overrides it.
    try {
      if (navigator.userAgent && navigator.userAgent.indexOf('HeadlessChrome/') !== -1) {
        var cleanUA = navigator.userAgent.replace('HeadlessChrome/', 'Chrome/');
        defineGetter(navProto, 'userAgent', function() { return cleanUA; });
        if (navigator.appVersion) {
          defineGetter(navProto, 'appVersion', function() {
            return navigator.appVersion.replace('HeadlessChrome/', 'Chrome/');
          });
        }
      }
    } catch (e) {}

    // navigator fallbacks: only patch suspicious empty values.
    try {
      if (!navigator.languages || navigator.languages.length === 0) {
        defineGetter(navProto, 'languages', function() { return Object.freeze(['en-US', 'en']); });
      }
    } catch (e) {}
    try {
      if (!navigator.vendor) {
        defineGetter(navProto, 'vendor', function() { return 'Google Inc.'; });
      }
    } catch (e) {}
    try {
      if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 2) {
        defineGetter(navProto, 'hardwareConcurrency', function() { return 4; });
      }
    } catch (e) {}

    // window.chrome app/runtime/csi/loadTimes shape.
    try {
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: {},
          writable: true,
          enumerable: true,
          configurable: false
        });
      }

      if (!('app' in window.chrome)) {
        defineValue(window.chrome, 'app', {
          isInstalled: false,
          InstallState: {
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed'
          },
          RunningState: {
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running'
          },
          getDetails: asNative(function getDetails() { return null; }, 'getDetails'),
          getIsInstalled: asNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
          runningState: asNative(function runningState() { return 'cannot_run'; }, 'runningState')
        });
      }

      if (!('runtime' in window.chrome)) {
        defineValue(window.chrome, 'runtime', {
          OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update'
          },
          OnRestartRequiredReason: {
            APP_UPDATE: 'app_update',
            OS_UPDATE: 'os_update',
            PERIODIC: 'periodic'
          },
          PlatformArch: {
            ARM: 'arm',
            ARM64: 'arm64',
            MIPS: 'mips',
            MIPS64: 'mips64',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformNaclArch: {
            ARM: 'arm',
            MIPS: 'mips',
            MIPS64: 'mips64',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformOs: {
            ANDROID: 'android',
            CROS: 'cros',
            LINUX: 'linux',
            MAC: 'mac',
            OPENBSD: 'openbsd',
            WIN: 'win'
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: 'no_update',
            THROTTLED: 'throttled',
            UPDATE_AVAILABLE: 'update_available'
          },
          get id() { return undefined; },
          connect: asNative(function connect() { return undefined; }, 'connect'),
          sendMessage: asNative(function sendMessage() { return undefined; }, 'sendMessage')
        });
      }

      if (!('csi' in window.chrome) && window.performance && window.performance.timing) {
        window.chrome.csi = asNative(function csi() {
          var timing = window.performance.timing;
          return {
            onloadT: timing.domContentLoadedEventEnd,
            startE: timing.navigationStart,
            pageT: Date.now() - timing.navigationStart,
            tran: 15
          };
        }, 'csi');
      }

      if (!('loadTimes' in window.chrome) && window.performance && window.performance.timing) {
        window.chrome.loadTimes = asNative(function loadTimes() {
          var performance = window.performance;
          var timing = performance.timing;
          var navEntry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
          var protocol = (navEntry && navEntry.nextHopProtocol) || 'h2';
          return {
            requestTime: timing.navigationStart / 1000,
            startLoadTime: timing.navigationStart / 1000,
            commitLoadTime: timing.responseStart / 1000,
            finishDocumentLoadTime: timing.domContentLoadedEventEnd / 1000,
            finishLoadTime: timing.loadEventEnd / 1000,
            firstPaintTime: timing.loadEventEnd / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: (navEntry && navEntry.type) || 'other',
            connectionInfo: protocol,
            npnNegotiatedProtocol: protocol,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: protocol === 'h2' || protocol === 'hq',
            wasNpnNegotiated: protocol === 'h2' || protocol === 'hq'
          };
        }, 'loadTimes');
      }
    } catch (e) {}

    // navigator.plugins and navigator.mimeTypes fallback for empty headless arrays.
    try {
      if (navigator.plugins && navigator.plugins.length === 0) {
        var pluginData = [
          {
            name: 'Chrome PDF Plugin',
            filename: 'internal-pdf-viewer',
            description: 'Portable Document Format',
            mimeTypes: ['application/x-google-chrome-pdf']
          },
          {
            name: 'Chrome PDF Viewer',
            filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
            description: '',
            mimeTypes: ['application/pdf']
          },
          {
            name: 'Native Client',
            filename: 'internal-nacl-plugin',
            description: '',
            mimeTypes: ['application/x-nacl', 'application/x-pnacl']
          }
        ];
        var mimeData = {
          'application/pdf': { suffixes: 'pdf', description: '', pluginName: 'Chrome PDF Viewer' },
          'application/x-google-chrome-pdf': { suffixes: 'pdf', description: 'Portable Document Format', pluginName: 'Chrome PDF Plugin' },
          'application/x-nacl': { suffixes: '', description: 'Native Client Executable', pluginName: 'Native Client' },
          'application/x-pnacl': { suffixes: '', description: 'Portable Native Client Executable', pluginName: 'Native Client' }
        };
        var makeArray = function(items, nameProp) {
          var arr = [];
          items.forEach(function(item, index) {
            arr[index] = item;
            Object.defineProperty(arr, item[nameProp], { value: item, enumerable: false, configurable: true });
          });
          Object.defineProperty(arr, 'length', { value: items.length, enumerable: false, configurable: true });
          defineValue(arr, 'item', asNative(function item(index) { return arr[index] || null; }, 'item'));
          defineValue(arr, 'namedItem', asNative(function namedItem(name) { return arr[name] || null; }, 'namedItem'));
          return arr;
        };
        var plugins = makeArray(pluginData.map(function(plugin) {
          var pluginObj = {
            name: plugin.name,
            filename: plugin.filename,
            description: plugin.description,
            length: plugin.mimeTypes.length,
            item: asNative(function item(index) { return pluginObj[index] || null; }, 'item'),
            namedItem: asNative(function namedItem(name) { return pluginObj[name] || null; }, 'namedItem')
          };
          plugin.mimeTypes.forEach(function(type, index) {
            pluginObj[index] = type;
            Object.defineProperty(pluginObj, type, { value: type, enumerable: false, configurable: true });
          });
          return pluginObj;
        }), 'name');
        defineValue(plugins, 'refresh', asNative(function refresh() {}, 'refresh'));
        var mimeTypes = makeArray(Object.keys(mimeData).map(function(type) {
          return {
            type: type,
            suffixes: mimeData[type].suffixes,
            description: mimeData[type].description,
            enabledPlugin: plugins[mimeData[type].pluginName]
          };
        }), 'type');
        if (window.PluginArray) {
          Object.setPrototypeOf(plugins, PluginArray.prototype);
        }
        if (window.MimeTypeArray) {
          Object.setPrototypeOf(mimeTypes, MimeTypeArray.prototype);
        }
        defineGetter(navProto, 'plugins', function() { return plugins; });
        defineGetter(navProto, 'mimeTypes', function() { return mimeTypes; });
      }
    } catch (e) {}

    // HTMLMediaElement codecs.
    try {
      var originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
      if (originalCanPlayType && !originalCanPlayType.__agentBrowserStealthPatched) {
        var canPlayType = function canPlayType(type) {
          if (typeof type === 'string') {
            var normalized = type.trim().toLowerCase();
            if (normalized.indexOf('video/mp4') === 0 && normalized.indexOf('avc1.42e01e') !== -1) {
              return 'probably';
            }
            if (normalized === 'audio/x-m4a;' || normalized === 'audio/x-m4a') {
              return 'maybe';
            }
            if (normalized === 'audio/aac;' || normalized === 'audio/aac') {
              return 'probably';
            }
          }
          return originalCanPlayType.apply(this, arguments);
        };
        Object.defineProperty(canPlayType, '__agentBrowserStealthPatched', { value: true });
        HTMLMediaElement.prototype.canPlayType = asNative(canPlayType, 'canPlayType');
      }
    } catch (e) {}

    // Permissions API notification behavior.
    try {
      if (window.Notification && window.Permissions && Permissions.prototype.query) {
        var originalQuery = Permissions.prototype.query;
        if (!originalQuery.__agentBrowserStealthPatched) {
          var query = function query(param) {
            if (param && param.name === 'notifications') {
              var state = location.protocol.indexOf('https') === 0 ? Notification.permission : 'denied';
              if (window.PermissionStatus) {
                return Promise.resolve(Object.setPrototypeOf({ state: state, onchange: null }, PermissionStatus.prototype));
              }
              return Promise.resolve({ state: state, onchange: null });
            }
            return originalQuery.apply(this, arguments);
          };
          Object.defineProperty(query, '__agentBrowserStealthPatched', { value: true });
          Permissions.prototype.query = asNative(query, 'query');
        }
      }
    } catch (e) {}

    // WebGL vendor/renderer: only mask obvious headless software values.
    try {
      var patchWebGL = function(proto) {
        if (!proto || !proto.getParameter || proto.getParameter.__agentBrowserStealthPatched) {
          return;
        }
        var originalGetParameter = proto.getParameter;
        var getParameter = function getParameter(param) {
          var result = originalGetParameter.apply(this, arguments);
          if (param === 37445 && (!result || String(result).indexOf('Google') !== -1)) {
            return 'Intel Inc.';
          }
          if (param === 37446 && (!result || String(result).indexOf('SwiftShader') !== -1)) {
            return 'Intel Iris OpenGL Engine';
          }
          return result;
        };
        Object.defineProperty(getParameter, '__agentBrowserStealthPatched', { value: true });
        proto.getParameter = asNative(getParameter, 'getParameter');
      };
      patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    } catch (e) {}

    // Headless outer dimensions.
    try {
      if (!window.outerWidth || !window.outerHeight) {
        Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth; }, configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: function() { return window.innerHeight + 85; }, configurable: true });
      }
    } catch (e) {}

    // srcdoc iframe contentWindow shape.
    try {
      var originalCreateElement = Document.prototype.createElement;
      if (originalCreateElement && !originalCreateElement.__agentBrowserStealthPatched) {
        var createElement = function createElement(tagName) {
          var element = originalCreateElement.apply(this, arguments);
          if (String(tagName).toLowerCase() === 'iframe') {
            try {
              var originalSrcdoc = element.srcdoc;
              Object.defineProperty(element, 'srcdoc', {
                configurable: true,
                get: function() { return originalSrcdoc; },
                set: function(value) {
                  if (!element.contentWindow) {
                    var proxy = new Proxy(window, {
                      get: function(target, key) {
                        if (key === 'self') return proxy;
                        if (key === 'frameElement') return element;
                        if (key === '0') return undefined;
                        return Reflect.get(target, key);
                      }
                    });
                    Object.defineProperty(element, 'contentWindow', {
                      get: function() { return proxy; },
                      configurable: false
                    });
                  }
                  Object.defineProperty(element, 'srcdoc', { value: value, writable: true, configurable: true });
                }
              });
            } catch (e) {}
          }
          return element;
        };
        Object.defineProperty(createElement, '__agentBrowserStealthPatched', { value: true });
        Document.prototype.createElement = asNative(createElement, 'createElement');
      }
    } catch (e) {}
  } catch(e) {}
})();`,
];

// ---------------------------------------------------------------------------
// userAgent
// ---------------------------------------------------------------------------

function getUserAgent(existingUserAgent?: string): string {
  const envUA = process.env["AGENT_BROWSER_STEALTH_USER_AGENT"];
  if (envUA && envUA.trim()) {
    return envUA.trim();
  }
  if (existingUserAgent && existingUserAgent.trim()) {
    return existingUserAgent.trim();
  }
  // Return empty string; agent-browser will use its own default
  // We deliberately do NOT hardcode a UA here to avoid platform fingerprint mismatch
  return "";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleManifest(): PluginManifestResponse {
  fileLog("handle.manifest");
  const resp: PluginManifestResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    manifest: {
      name: "agent-browser-plugin-stealth",
      capabilities: ["launch.mutate"],
      description:
        "Append local Chrome launch args, extensions, init scripts, userAgent overrides, and real user-profile args (--user-data-dir/--profile-directory) for stealth automation.",
    },
  };
  fileLog("handle.manifest.response", { manifest: resp.manifest });
  return resp;
}

function handleLaunchMutate(req: LaunchMutateRequest): LaunchMutateResponse {
  const profile = resolveProfileConfig(req);

  fileLog("handle.launchMutate.request", {
    argsCount: (req.args ?? []).length,
    extensionsCount: (req.extensions ?? []).length,
    initScriptsCount: (req.initScripts ?? []).length,
    hasUserAgent: Boolean(req.userAgent),
    profileDirectory: profile.profileDirectory,
  });

  const existingArgs = req.args ?? [];
  const stealthArgs = getStealthArgs(existingArgs);
  const args = appendProfileArgs(stealthArgs, profile);
  const extensions = getExtensions(req.extensions ?? []);
  const initScripts = Array.from(new Set([...(req.initScripts ?? []), ...INIT_SCRIPTS]));
  const userAgent = getUserAgent(req.userAgent);

  const resp: LaunchMutateResponse = {
    protocol: "agent-browser.plugin.v1",
    success: true,
    launch: {
      args,
      extensions,
      initScripts,
      userAgent,
    },
  };

  fileLog("handle.launchMutate.response", {
    argsCount: args,
    extensionsCount: extensions,
    initScriptsCount: initScripts.length,
    userAgent: userAgent || "(none)",
    profileDirectory: profile.profileDirectory,
  });

  return resp;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function dispatch(envelope: PluginEnvelope): PluginResponse {
  const isOfficial = envelope.protocol === "agent-browser.plugin.v1";
  const isLegacy = !envelope.protocol;

  fileLog("dispatch.request", { type: envelope.type, protocol: envelope.protocol ?? "legacy" });

  if (!isOfficial && !isLegacy) {
    const err = makeError(
      "unsupported_protocol",
      `Unsupported protocol: "${String(envelope.protocol)}". Expected "agent-browser.plugin.v1".`
    );
    fileLog("dispatch.error", err.error);
    return err;
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
        req = envelope.launch as LaunchMutateRequest;
      }
      return handleLaunchMutate(req);
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

// ---------------------------------------------------------------------------
// stdin/stdout entry point — NDJSON support for multi-line test compat
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fileLog("plugin.start", { pid: process.pid, cwd: process.cwd() });
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
