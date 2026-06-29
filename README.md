# agent-browser-loader

## Plugins

This workspace contains local plugins for [agent-browser](https://github.com/agent-browser/agent-browser).

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
