#!/usr/bin/env node

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import { resolve } from "path";

function resolveChromeExecutable(explicit?: string): string {
  if (explicit && explicit.trim()) {
    const p = resolve(explicit.trim());
    if (existsSync(p)) {
      return p;
    }
    throw new Error(`Chrome executable not found: ${p}`);
  }

  const plat = platform();
  const candidates: string[] = [];

  if (plat === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (plat !== "win32") {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      try {
        const found = execFileSync("which", [name], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        if (found) {
          candidates.push(found);
        }
      } catch {
        // not on PATH; try next
      }
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }

  throw new Error("Could not find a Chrome/Chromium executable on this system.");
}

function parseExecutablePath(argv: string[]): string | undefined {
  const idx = argv.findIndex((arg) => arg === "--executable-path");
  return idx >= 0 ? argv[idx + 1] : undefined;
}

try {
  const executablePath = resolveChromeExecutable(parseExecutablePath(process.argv.slice(2)));
  process.stdout.write(executablePath + "\n");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(msg + "\n");
  process.exit(1);
}
