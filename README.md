# agent-browser-loader

## Plugins

This workspace contains local plugins for [agent-browser](https://github.com/agent-browser/agent-browser).

---

## agent-browser-plugin-stealth

A local `launch.mutate` plugin that appends stealth-related Chrome launch arguments, extensions, initScripts, and a custom userAgent to agent-browser local launches. It also injects real Chrome user-profile args (`--user-data-dir` / `--profile-directory`) so a logged-in profile can be reused on the local launch path while still loading extensions.

> This plugin merges the former `agent-browser-plugin-userprofile-browser` plugin. Both shared the `launch.mutate` capability, so they are now a single plugin.

### Scope and Limitations

**This plugin only affects local agent-browser `launch`.** It does NOT modify:
- Browsers started via `--cdp` (CDP connect mode)
- Browsers started via `--auto-connect`
- Browsers provided by a `browser.provider` plugin (e.g. cloud-browser)

If you need stealth args when using a `browser.provider`, pass them explicitly in the `browser.launch` request `args` field. Because profile injection now runs on the same `launch.mutate` pipeline, it can be used together with `--extension`.

### Build

```bash
cd plugins/agent-browser-plugin-stealth
bun run build
```

Produces `dist/index.js`. The plugin is configured in `agent-browser.json`:

```json
{
  "name": "stealth",
  "command": "node",
  "args": ["./plugins/agent-browser-plugin-stealth/dist/index.js"],
  "capabilities": ["launch.mutate"]
}
```

### Environment Variables

| Variable | Description |
|---|---|
| `AGENT_BROWSER_STEALTH_ARGS` | Extra Chrome args to append (comma or newline separated) |
| `AGENT_BROWSER_STEALTH_EXTENSION` | Single Chrome extension absolute path |
| `AGENT_BROWSER_STEALTH_EXTENSIONS` | Multiple Chrome extension absolute paths (comma or newline separated) |
| `AGENT_BROWSER_STEALTH_USER_AGENT` | Override the userAgent string |
| `AGENT_BROWSER_STEALTH_NO_SANDBOX` | Set to `1` or `true` to add `--no-sandbox` (see Security Risks) |
| `AGENT_BROWSER_USERPROFILE_DIR` | Chrome user data dir for `--user-data-dir` (also `AGENT_BROWSER_USERPROFILE_NAME`) |
| `AGENT_BROWSER_PROFILE_DIRECTORY` | Chrome profile name for `--profile-directory` (default `Default`) |

**Extension paths must be absolute.** Relative paths or non-existent paths produce a warning on stderr; the extension is skipped rather than silently misconfigured.

### Launch Args Strategy

The plugin preserves caller-provided launch args, then strips common automation/default switches before returning the mutated launch config:

- `--enable-automation`
- `--disable-extensions`
- `--disable-default-apps`
- `--disable-component-extensions-with-background-pages`

It then merges `AutomationControlled` into an existing `--disable-blink-features=...` value or appends `--disable-blink-features=AutomationControlled` when the flag is absent. This is the launch-arg equivalent of Selenium's `excludeSwitches: ["enable-automation"]` pattern. `useAutomationExtension: false` has no standalone Chrome CLI flag in this plugin surface; avoiding `--enable-automation` is the relevant part here.

### Protocol Examples

#### `plugin.manifest`

Request:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "plugin.manifest",
  "capability": "plugin.manifest",
  "request": {}
}
```

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "manifest": {
    "name": "agent-browser-plugin-stealth",
    "capabilities": ["launch.mutate"],
    "description": "Append local Chrome launch args, extensions, init scripts, userAgent overrides, and real user-profile args (--user-data-dir/--profile-directory) for stealth automation."
  }
}
```

#### `launch.mutate` (official envelope)

Request:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "launch.mutate",
  "capability": "launch.mutate",
  "request": {
    "args": []
  }
}
```

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "launch": {
    "args": ["--disable-blink-features=AutomationControlled"],
    "extensions": [],
    "initScripts": [
      "(function() { try { Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; }, configurable: true }); } catch(e) {} })();"
    ],
    "userAgent": ""
  }
}
```

#### `launch.mutate` (NDJSON/id simplified format)

Request:
```json
{"type":"launch.mutate","id":"req-1","launch":{"args":[]}}
```

Response (id is preserved):
```json
{"id":"req-1","launch":{"args":["--disable-blink-features=AutomationControlled"],"extensions":[],"initScripts":[...],"userAgent":""}}
```

Multiple requests can be sent as newline-delimited JSON (NDJSON); each line produces one response line.

#### Error response

Official envelope error:
```json
{"protocol":"agent-browser.plugin.v1","success":false,"error":{"code":"unsupported_type","message":"Unsupported request type: \"foo\"."}}
```

NDJSON/id error:
```json
{"id":"req-1","error":{"code":"parse_error","message":"JSON parse error: ..."}}
```

### initScripts

The plugin injects one bundled, idempotent stealth script into every page. It covers the generic evasion categories that fit this plugin's initScript-only surface:

1. **Hide `navigator.webdriver`** - deletes or overrides the prototype getter when automation exposes it.
2. **Clean obvious headless UA leaks** - replaces `HeadlessChrome/` with `Chrome/` if no higher-level UA override already handled it.
3. **Patch `window.chrome` shape** - adds `chrome.app`, `chrome.runtime`, `chrome.csi`, and `chrome.loadTimes` only when missing.
4. **Patch empty navigator fields** - fills empty `languages`, missing `vendor`, low `hardwareConcurrency`, and empty `plugins`/`mimeTypes` fallbacks.
5. **Patch browser APIs with common headless gaps** - media codec responses, notification permissions, WebGL SwiftShader values, missing outer dimensions, and `srcdoc` iframe `contentWindow`.
6. **Patch stealth anti-debug probes** - replaces `console.table` with a native-looking no-op and shadows `performance.now` with a native-looking monotonic clock based on navigation start.

The script is deliberately generic. It patches missing or clearly headless-shaped values, avoids site-specific behavior, and does not override already-populated `navigator.plugins`, `navigator.languages`, or real extension-provided objects.

The `console.table` and `performance.now` hooks are intentionally small. They target JavaScript devtools timing checks that compare repeated `performance.now()` calls or use `console.table()` side effects to detect debugging. The `performance.now()` hook stores the last returned value and, when the current clock value is less than or equal to it, returns `last + 0.001` so tight same-millisecond calls cannot produce `t1 === t2`.

### userAgent Strategy

- If `AGENT_BROWSER_STEALTH_USER_AGENT` is set, that value is used.
- Otherwise, an empty string is returned — agent-browser uses its own default UA.
- Do **not** hardcode a UA in this plugin. A stale or platform-mismatched UA creates new fingerprint anomalies rather than eliminating them. Use the env var to supply the correct UA for your runtime.

### Security Risks

| Risk | Details |
|---|---|
| `--no-sandbox` | Disabled by default. Enable only via `AGENT_BROWSER_STEALTH_NO_SANDBOX=1`. Reduces browser sandbox isolation — only use in sandboxed CI/container environments. |
| Stripped default args | The plugin removes `--disable-extensions` and related default switches to match a more normal Chrome shape. Do not use the stealth plugin when those flags are required for isolation. |
| Stale userAgent | Hardcoded UAs go stale. Always set `AGENT_BROWSER_STEALTH_USER_AGENT` to match your actual platform. |
| Anti-detection script failure | Sites update detection heuristics frequently. These scripts provide generic minimum coverage and do not guarantee bypass of any specific site's bot detection. |
| Third-party extension API keys | Extension paths loaded via `AGENT_BROWSER_STEALTH_EXTENSION(S)` may require external API keys. Never commit API keys to `agent-browser.json` or any tracked file. Set them as environment variables at runtime. |
| Over-modifying browser APIs | Aggressive overrides can break page functionality. This plugin uses fallback-only patches where possible and keeps the behavior generic. |

---

## agent-browser-plugin-userprofile-browser

A local `launch.mutate` plugin that appends Chrome user profile launch arguments to agent-browser local launches.

### Purpose

Use this plugin when you want agent-browser to reuse a real Chrome profile while staying on the local browser launch path. This matters for extension workflows because agent-browser rejects `--extension` when `--provider` is used.

### Usage

```bash
agent-browser --extension ./capsolver-extension --headed open chrome://extensions
```

With explicit profile selection:

```bash
AGENT_BROWSER_USERPROFILE_DIR="$HOME/Library/Application Support/Google/Chrome" \
AGENT_BROWSER_PROFILE_DIRECTORY="Default" \
agent-browser --extension ./capsolver-extension --headed open https://example.com
```

Do not call this plugin with `--provider`. It is configured in `agent-browser.json` as a launch mutator and runs during local launches.

### Build

```bash
cd plugins/agent-browser-plugin-userprofile-browser
bun run build
```

Produces `dist/index.js`. The plugin is configured in `agent-browser.json` to be called via `node`.

### Environment Variables

| Variable | Description |
|---|---|
| `AGENT_BROWSER_USERPROFILE_DIR` | Override the Chrome user data directory path |
| `AGENT_BROWSER_USERPROFILE_NAME` | Alias for `AGENT_BROWSER_USERPROFILE_DIR` |
| `AGENT_BROWSER_PROFILE_DIRECTORY` | Override the profile directory name (e.g. `Default`, `Profile 1`) |

### Profile Selection Strategy

1. `request.userDataDir` → `AGENT_BROWSER_USERPROFILE_DIR` → platform default
   - macOS: `~/Library/Application Support/Google/Chrome`
   - Linux: `${XDG_CONFIG_HOME:-~/.config}/google-chrome` (falls back to `chromium`)
2. `request.profileDirectory` → `AGENT_BROWSER_PROFILE_DIRECTORY` → `Default`

The `request.*` fields are useful for direct protocol tests. In normal agent-browser CLI use, set the environment variables above.

### Launch Args Strategy

The plugin preserves caller-provided launch args, extensions, initScripts, and userAgent, then appends missing profile args:

- `--user-data-dir=<resolved user data dir>`
- `--profile-directory=<profile directory>`
- `--no-first-run`
- `--no-default-browser-check`

If the incoming launch already includes one of those flags, the explicit caller-provided value is preserved.

### Protocol Examples

#### `plugin.manifest`

Request:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "plugin.manifest",
  "capability": "plugin.manifest",
  "request": {}
}
```

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "manifest": {
    "name": "agent-browser-plugin-userprofile-browser",
    "capabilities": ["launch.mutate"],
    "description": "Append Chrome user profile launch args so local agent-browser launches can reuse a selected profile."
  }
}
```

#### `launch.mutate`

Request:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "launch.mutate",
  "capability": "launch.mutate",
  "request": {
    "args": [],
    "extensions": ["/absolute/path/to/extension"],
    "initScripts": [],
    "userAgent": ""
  }
}
```

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "launch": {
    "args": [
      "--user-data-dir=/Users/example/Library/Application Support/Google/Chrome",
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check"
    ],
    "extensions": ["/absolute/path/to/extension"],
    "initScripts": [],
    "userAgent": ""
  }
}
```

### Profile Lock Risk

Chrome locks its user data directory while it is running. This plugin only mutates launch args; it does not inspect, delete, or repair Chrome lock files. If Chrome refuses to start with a selected profile, close the existing Chrome process for that profile or choose a different user data directory.

### Security Notice

This plugin points Chrome at real user profiles, which can contain cookies, login sessions, and other sensitive data. It never reads profile contents. Logs must not include cookies, tokens, or local profile file contents.
