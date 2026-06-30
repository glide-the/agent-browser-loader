# agent-browser-loader

## Plugins

This workspace contains local plugins for [agent-browser](https://github.com/agent-browser/agent-browser).

---

## agent-browser-plugin-stealth

A local `launch.mutate` plugin that appends stealth-related Chrome launch arguments, extensions, initScripts, and a custom userAgent to agent-browser local launches. It also injects Chrome user-profile args (`--user-data-dir` / `--profile-directory`) read from the state file written by `agent-browser-plugin-userprofile-browser`, so a logged-in profile can be reused on the local launch path while still loading extensions.

> The heavy one-time profile rsync lives in the `agent-browser-plugin-userprofile-browser` `command.run` plugin (see below). This `launch.mutate` plugin only reads the persisted launch directory, so it never blocks startup with a sync.

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
| `AGENT_BROWSER_STEALTH_NO_SANDBOX` | Set to `1` or `true` to add `--no-sandbox` (see Security Risks) |

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
`agent-browser-plugin-userprofile-browser` `command.run` plugin (see below). This
`launch.mutate` plugin only **reads** the resulting launch directory:

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
| `--no-sandbox` | Disabled by default. Enable only via `AGENT_BROWSER_STEALTH_NO_SANDBOX=1`. Reduces browser sandbox isolation — only use in sandboxed CI/container environments. |
| Stripped default args | The plugin removes `--disable-extensions` and related default switches to match a more normal Chrome shape. Do not use the stealth plugin when those flags are required for isolation. |
| Stale userAgent | Hardcoded UAs go stale. Always set `AGENT_BROWSER_STEALTH_USER_AGENT` to match your actual platform. |
| Anti-detection script failure | Sites update detection heuristics frequently. These scripts provide generic minimum coverage and do not guarantee bypass of any specific site's bot detection. |
| Third-party extension API keys | Extension paths loaded via `AGENT_BROWSER_STEALTH_EXTENSION(S)` may require external API keys. Never commit API keys to `agent-browser.json` or any tracked file. Set them as environment variables at runtime. |
| Over-modifying browser APIs | Aggressive overrides can break page functionality. This plugin uses fallback-only patches where possible and keeps the behavior generic. |

---

## agent-browser-plugin-userprofile-browser

A `command.run` plugin that prepares a real Chrome profile for stealth automation. It performs a **one-time** full `rsync` of the real Chrome profile into a separate `RemoteDebug` user-data-dir — bypassing Chrome's "non-default data directory" detection and the live-profile lock — then persists the resulting launch directory to a local state file. The `agent-browser-plugin-stealth` `launch.mutate` plugin reads that state file and injects `--user-data-dir` / `--profile-directory`, so the heavy sync runs once instead of blocking every launch.

### Why a separate plugin

`launch.mutate` runs on *every* local launch. Putting the profile `rsync` there blocked startup repeatedly. Moving it to `command.run` means the sync is an explicit, one-time step:

```bash
# 1. Sync the real profile once and persist the launch dir
agent-browser plugin run userprofile-browser browser.launch

# 2. Normal launches now reuse the synced profile (stealth reads the state file)
agent-browser --extension ./capsolver-extension --headed open https://example.com

# 3. Clean up the persisted state when done
agent-browser plugin run userprofile-browser browser.close
```

To refresh the synced profile (e.g. to pick up new cookies), pass `force`:

```bash
agent-browser plugin run userprofile-browser browser.launch --payload '{"force":true}'
```

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
  "capabilities": ["command.run"]
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
| `statePath` | Path of the shared state file (default `<cwd>/.agent-browser/userprofile-browser-state.json`) |

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

### Request types

#### `browser.launch`

`rsync`-syncs `source/<profile>/` → `debug/<profile>/` (excluding lock, log, journal, and cache files) and writes the state file. Idempotent: if the state file already exists it skips the sync unless `force: true` is passed.

Request payload (all optional):
```json
{ "userDataDir": "...", "profileDirectory": "Default", "debugDir": "...", "force": false }
```

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": {
    "userDataDir": "/Users/example/Library/Application Support/Google/ChromeRemoteDebug",
    "profileDirectory": "Default",
    "source": "/Users/example/Library/Application Support/Google/Chrome",
    "synced": true,
    "statePath": "/abs/.agent-browser/userprofile-browser-state.json"
  }
}
```

#### `browser.close`

Removes the persisted state file (and, with `{"removeDebugDir":true}`, the synced debug dir).

Response:
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": { "closed": true, "removedState": true, "removedDebugDir": false }
}
```

### State file

The state file is the contract between the two plugins. Both default to `<cwd>/.agent-browser/userprofile-browser-state.json`; relocate it by setting `statePath` in `.agent-browser/userprofile.config.json` (read by both plugins).

```json
{
  "userDataDir": "/Users/example/Library/Application Support/Google/ChromeRemoteDebug",
  "profileDirectory": "Default",
  "source": "/Users/example/Library/Application Support/Google/Chrome",
  "syncedAt": "2026-06-30T00:00:00.000Z"
}
```

### Profile Lock Risk

The plugin never starts or kills Chrome and never deletes Chrome lock files. The `rsync` excludes `SingletonLock`/`LOCK`/journal/cache files so the copy is safe even while the real Chrome is running, but for a fully consistent snapshot run `browser.launch` while Chrome is closed.

### Security Notice

This plugin copies real user profiles, which can contain cookies, login sessions, and other sensitive data. It never reads or logs profile contents. Logs must not include cookies, tokens, or local profile file contents.

