# agent-browser-loader

## Plugins

This workspace contains local plugins for [agent-browser](https://github.com/agent-browser/agent-browser).

---

## agent-browser-plugin-stealth

A local `launch.mutate` plugin that appends stealth-related Chrome launch arguments, extensions, initScripts, and a custom userAgent to agent-browser local launches.

### Scope and Limitations

**This plugin only affects local agent-browser `launch`.** It does NOT modify:
- Browsers started via `--cdp` (CDP connect mode)
- Browsers started via `--auto-connect`
- Browsers provided by a `browser.provider` plugin (e.g. cloud-browser, userprofile-browser)

If you need stealth args when using a `browser.provider`, pass them explicitly in the `browser.launch` request `args` field.
For `agent-browser-plugin-userprofile-browser`, launch mode still needs a CDP endpoint and owns its remote debugging setup; this `launch.mutate` plugin cannot remove or rewrite provider core args after the provider has launched Chrome.

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
    "description": "Append local Chrome launch args, extensions, init scripts, and userAgent overrides for stealth automation."
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

The script is deliberately generic. It patches missing or clearly headless-shaped values, avoids site-specific behavior, and does not override already-populated `navigator.plugins`, `navigator.languages`, or real extension-provided objects.

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

A local `browser.provider` plugin that launches or connects to a Chrome browser using a real user profile, returning a CDP URL for agent-browser to consume.

### Purpose

Use this plugin when you want agent-browser to work with a real Chrome profile (cookies, extensions, logged-in sessions) rather than a sandboxed headless browser.

### Usage

```bash
agent-browser --provider agent-browser-plugin-userprofile-browser open https://example.com
```

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
| `CHROME_PATH` | Path to Chrome/Chromium executable |
| `AGENT_BROWSER_CDP_URL` | Provide a pre-existing CDP WebSocket URL to connect mode |

### Profile Selection Strategy

1. `request.userDataDir` → `AGENT_BROWSER_USERPROFILE_DIR` → platform default
   - macOS: `~/Library/Application Support/Google/Chrome`
   - Linux: `${XDG_CONFIG_HOME:-~/.config}/google-chrome` (falls back to `chromium`)
2. `request.profileDirectory` → `AGENT_BROWSER_PROFILE_DIRECTORY` → `Default`

### Chrome Executable Detection

Priority order:
1. `request.executablePath`
2. `CHROME_PATH` environment variable
3. macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
4. Linux: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` (via `which`)

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
    "capabilities": ["browser.provider"],
    "description": "Launch or connect Chrome with a selected user profile for agent-browser."
  }
}
```

#### `browser.launch`

Request:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.launch",
  "capability": "browser.provider",
  "request": {
    "profileDirectory": "Default"
  }
}
```

Response (launch mode):
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "browser": {
    "cdpUrl": "ws://127.0.0.1:9222/devtools/browser/session",
    "directPage": false,
    "metadata": {
      "userDataDir": "/Users/example/Library/Application Support/Google/Chrome",
      "profileDirectory": "Default",
      "mode": "launch",
      "sessionId": "userprofile-launch-12345-1700000000000",
      "port": 9222
    },
    "cleanup": {
      "sessionId": "userprofile-launch-12345-1700000000000"
    }
  }
}
```

Response (connect mode — when `cdpUrl` is provided in request or env):
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "browser": {
    "cdpUrl": "ws://127.0.0.1:9222/devtools/browser/existing-session",
    "directPage": false,
    "metadata": {
      "userDataDir": "/Users/example/Library/Application Support/Google/Chrome",
      "profileDirectory": "Default",
      "mode": "connect",
      "sessionId": "userprofile-connect-1700000000000"
    }
  }
}
```

#### `browser.close`

Request:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.close",
  "capability": "browser.provider",
  "request": {
    "sessionId": "userprofile-launch-12345-1700000000000"
  }
}
```

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": {
    "closed": true
  }
}
```

### Profile Lock Risk

Chrome locks its user data directory with a `SingletonLock` (Linux) or similar platform file while running. If the profile is already locked:

- The plugin will attempt to connect to an existing remote debugging Chrome on ports 9222–9225.
- If none is found, it returns a `profile_locked` error — **it never deletes the lock file**.
- To avoid this, either close Chrome first or use `cdpUrl`/`port` to connect to an already-debugging instance.

### Cleanup Behavior

- **Launch mode**: `browser.close` sends `SIGTERM` to the Chrome process started by this plugin.
- **Connect mode**: `browser.close` is a no-op — it does not close the user's existing Chrome.
- Repeated `browser.close` calls are idempotent (return `{ closed: false, noOp: true }`).

### `user-data-dir` / `profile-directory` vs `browser.cdpUrl`

The official `browser.provider` contract requires `browser.cdpUrl` in the response — agent-browser uses this WebSocket URL to connect via CDP. The `user-data-dir` and `profile-directory` values are informational metadata stored in `browser.metadata` (not top-level browser fields), used for tracing and debugging.

### `launch.mutate` and stealth

The independent `stealth` (`launch.mutate`) plugin does **not** automatically modify a browser that was already launched or connected by this provider. If you need stealth args applied to a user-profile Chrome, pass those args via `request.args` in the `browser.launch` request instead of relying on a separate mutate plugin.

### Security Notice

This plugin accesses real Chrome user profiles which contain cookies, login sessions, and other sensitive data. Logs are written only to stderr and never include cookie values, tokens, or profile file contents.
