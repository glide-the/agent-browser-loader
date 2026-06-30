# agent-browser-loader

## Plugins

This workspace contains local plugins for [agent-browser](https://github.com/agent-browser/agent-browser).

---

## agent-browser-plugin-stealth

A local `launch.mutate` plugin that appends stealth-related Chrome launch arguments, extensions, initScripts, and a custom userAgent to agent-browser local launches. It also injects Chrome user-profile args (`--user-data-dir` / `--profile-directory`) read from the state file written by `agent-browser-plugin-userprofile-browser`, so a logged-in profile can be reused on the local launch path while still loading extensions.

> The heavy one-time profile rsync + Chrome launch lives in the `agent-browser-plugin-userprofile-browser` `browser.provider` plugin (see below). This `launch.mutate` plugin only reads the persisted launch directory on the local-launch path, so it never blocks startup with a sync.

### Scope and Limitations

**This plugin only affects local agent-browser `launch`.** It does NOT modify:
- Browsers started via `--cdp` (CDP connect mode)
- Browsers started via `--auto-connect`
- Browsers provided by a `browser.provider` plugin (e.g. cloud-browser)

If you need stealth args when using a `browser.provider`, pass them explicitly in the `browser.launch` request `args` field. Because profile injection runs on the same `launch.mutate` pipeline, it can be used together with `--extension`.

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

Chrome **profile** settings (`--user-data-dir` / `--profile-directory`) are NOT read from
environment variables — agent-browser spawns plugins as subprocesses, so env vars can't be
relied on to reach them. The launch directory comes from the state file written by
`agent-browser-plugin-userprofile-browser`, with the local config file
`.agent-browser/userprofile.config.json` (see that plugin below) as a fallback.

**Extension paths must be absolute.** Relative paths or non-existent paths produce a warning on stderr; the extension is skipped rather than silently misconfigured.

### Profile reuse (logged-in profile)

To reuse a logged-in Chrome profile, Chrome cannot be launched with `--user-data-dir`
pointing at the real Chrome data directory: automation against the default data directory is
blocked, and the live profile is locked while Chrome is running. The one-time `rsync` into a
separate `RemoteDebug` user-data-dir is therefore handled by the
`agent-browser-plugin-userprofile-browser` `browser.provider` plugin (see below). On the
local-launch (`launch.mutate`) path, this stealth plugin only **reads** the resulting launch
directory:

- It reads `.agent-browser/userprofile-browser-state.json` and injects `--user-data-dir` /
  `--profile-directory` from it.
- If no state file exists yet, it falls back to `debugDir` / `profileDirectory` from
  `.agent-browser/userprofile.config.json`, then the platform default.
- Resolution priority: request param → persisted state → config file → platform default.

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
| Stripped default args | The plugin removes `--disable-extensions` and related default switches to match a more normal Chrome shape. Do not use the stealth plugin when those flags are required for isolation. |
| Stale userAgent | Hardcoded UAs go stale. Always set `AGENT_BROWSER_STEALTH_USER_AGENT` to match your actual platform. |
| Anti-detection script failure | Sites update detection heuristics frequently. These scripts provide generic minimum coverage and do not guarantee bypass of any specific site's bot detection. |
| Third-party extension API keys | Extension paths loaded via `AGENT_BROWSER_STEALTH_EXTENSION(S)` may require external API keys. Never commit API keys to `agent-browser.json` or any tracked file. Set them as environment variables at runtime. |
| Over-modifying browser APIs | Aggressive overrides can break page functionality. This plugin uses fallback-only patches where possible and keeps the behavior generic. |

---

## agent-browser-plugin-userprofile-browser

A `browser.provider` plugin (`--provider userprofile-browser`) that prepares and drives a real
Chrome profile for stealth automation. On `browser.launch` it performs a **one-time** full
`rsync` of the real Chrome profile into a separate `RemoteDebug` user-data-dir — bypassing
Chrome's "non-default data directory" detection and the live-profile lock — then launches Chrome
from that copy with a remote-debugging port and returns the CDP WebSocket URL. agent-browser
connects to that URL to drive the logged-in profile. Because the provider launches Chrome
itself, it can load the profile and extensions directly (the provider path, unlike `--provider`
+ `--extension` mixing, is fully under the plugin's control).

### Why a browser.provider

`launch.mutate` runs on *every* local launch — putting the heavy profile `rsync` there blocked
startup repeatedly. As a `browser.provider`, the sync + Chrome launch happen once per session
and agent-browser simply attaches to the returned CDP URL:

```bash
# Launch Chrome from the synced logged-in profile and drive it
agent-browser --provider userprofile-browser open https://example.com
```

The provider tracks each launched Chrome in a local **session registry** so a later
`browser.close` (a separate process) can terminate it by `sessionId`.

### Build

```bash
cd plugins/agent-browser-plugin-userprofile-browser
bun run build
```

Produces `dist/index.js`. The plugin is configured in `agent-browser.json`:

```json
{
  "name": "userprofile-browser",
  "command": "node",
  "args": ["./plugins/agent-browser-plugin-userprofile-browser/dist/index.js"],
  "capabilities": ["browser.provider"]
}
```

### Configuration (local file)

agent-browser spawns plugins as subprocesses, so environment variables can't be relied on to
reach them. Configuration is read from a local JSON file shared with the stealth plugin:

```
<cwd>/.agent-browser/userprofile.config.json
```

```json
{
  "userDataDir": "/Users/example/Library/Application Support/Google/Chrome",
  "profileDirectory": "Default",
  "debugDir": "/Users/example/Library/Application Support/Google/ChromeRemoteDebug",
  "statePath": ".agent-browser/userprofile-browser-state.json"
}
```

| Field | Description |
|---|---|
| `userDataDir` | Source Chrome user-data-dir to copy FROM |
| `profileDirectory` | Profile sub-directory name to sync (default `Default`) |
| `debugDir` | Target `RemoteDebug` user-data-dir to copy TO and launch FROM (default `<source>RemoteDebug` sibling) |
| `statePath` | Path of the sync-marker state file (default `<cwd>/.agent-browser/userprofile-browser-state.json`) |

All fields are optional. The corresponding `AGENT_BROWSER_USERPROFILE_DIR` /
`AGENT_BROWSER_USERPROFILE_NAME` / `AGENT_BROWSER_PROFILE_DIRECTORY` /
`AGENT_BROWSER_USERPROFILE_DEBUG_DIR` / `AGENT_BROWSER_USERPROFILE_STATE` environment variables
are still honored as a last-resort fallback, but the config file is the primary mechanism.

### Profile / directory resolution

1. **Source** (`request.userDataDir` → config `userDataDir` → env → platform default)
   - macOS: `~/Library/Application Support/Google/Chrome`
   - Linux: `${XDG_CONFIG_HOME:-~/.config}/google-chrome` (falls back to `chromium`)
2. **Profile** (`request.profileDirectory` → config `profileDirectory` → env → `Default`)
3. **Target debug dir** (`request.debugDir` → config `debugDir` → env → `<source>RemoteDebug` sibling, e.g. `~/Library/Application Support/Google/ChromeRemoteDebug`)
4. **State file** (config `statePath` → env `AGENT_BROWSER_USERPROFILE_STATE` → `<cwd>/.agent-browser/userprofile-browser-state.json`)
5. **Chrome executable** (`request.executablePath` → platform default: macOS `/Applications/Google Chrome.app/...`; Linux `google-chrome`/`chromium` on `PATH`)

### Request types (capability `browser.provider`)

#### `browser.launch`

`rsync`-syncs `source/<profile>/` → `debug/<profile>/` (excluding lock, log, journal, and cache
files), launches Chrome with `--remote-debugging-port`, `--user-data-dir=<debug>`,
`--profile-directory`, and resolves the CDP URL from `<debug>/DevToolsActivePort`. The rsync is
idempotent — it is skipped if the profile was already synced unless `force: true`. If `cdpUrl`
is supplied, the plugin connects to that running Chrome instead of launching.

Request (all optional):
```json
{
  "userDataDir": "...",
  "profileDirectory": "Default",
  "debugDir": "...",
  "executablePath": "/path/to/chrome",
  "cdpUrl": "ws://127.0.0.1:9222/...",
  "port": 0,
  "args": ["--headless=new"],
  "force": false
}
```

Response (field `browser`):
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "browser": {
    "cdpUrl": "ws://127.0.0.1:63009/devtools/browser/<id>",
    "directPage": false,
    "metadata": {
      "userDataDir": "/Users/example/Library/Application Support/Google/ChromeRemoteDebug",
      "profileDirectory": "Default",
      "source": "/Users/example/Library/Application Support/Google/Chrome",
      "mode": "launch",
      "sessionId": "userprofile-launch-92349-1782821944151",
      "port": 63009,
      "pid": 92368,
      "synced": true
    },
    "cleanup": { "sessionId": "userprofile-launch-92349-1782821944151" }
  }
}
```

`mode` is `"launch"` (Chrome spawned) or `"connect"` (attached to a supplied `cdpUrl`).

#### `browser.close`

Terminates the Chrome started by `browser.launch` (looked up by `sessionId` in the session
registry). Idempotent: an unknown / already-closed session is a `noOp` success. With
`{"removeDebugDir":true}` it also removes the synced debug dir and the sync marker.

Request:
```json
{ "sessionId": "userprofile-launch-92349-1782821944151", "removeDebugDir": false }
```

Response (field `data`):
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": { "closed": true, "removedDebugDir": false }
}
```

Idempotent / connect-mode response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": { "closed": false, "noOp": true }
}
```

### State & session files

- **Sync marker** `<cwd>/.agent-browser/userprofile-browser-state.json` — records the synced
  launch dir so the rsync runs only once (also consumed by the stealth plugin's local-launch
  fallback). Relocate via `statePath` in the config file.

  ```json
  {
    "userDataDir": "/Users/example/Library/Application Support/Google/ChromeRemoteDebug",
    "profileDirectory": "Default",
    "source": "/Users/example/Library/Application Support/Google/Chrome",
    "syncedAt": "2026-06-30T00:00:00.000Z"
  }
  ```

- **Session registry** `<cwd>/.agent-browser/userprofile-browser-sessions.json` — maps
  `sessionId` → `{ mode, pid, port, cdpUrl, userDataDir, profileDirectory, startedAt }` for live
  Chrome processes, so `browser.close` can terminate them.

### Error codes

| code | meaning |
|---|---|
| `profile_not_found` | the source `<userDataDir>/<profileDirectory>` does not exist |
| `chrome_not_found` | no Chrome/Chromium executable found (pass `executablePath`) |
| `launch_failed` | Chrome failed to start or the DevTools endpoint never appeared |

### Profile Lock Risk

The provider launches Chrome only against the **synced copy**, never the real Chrome data dir.
The `rsync` excludes `SingletonLock`/`LOCK`/journal/cache files so the copy is safe even while
the real Chrome is running, but for a fully consistent snapshot run `browser.launch` while the
real Chrome is closed.

### Security Notice

This plugin copies real user profiles, which can contain cookies, login sessions, and other sensitive data. It never reads or logs profile contents. Logs must not include cookies, tokens, or local profile file contents.

