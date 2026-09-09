/**
 * Resolve CLI executables that a packaged GUI process cannot see.
 *
 * macOS/Linux applications launched from Finder/Dock inherit a minimal PATH,
 * so user-installed CLIs (claude, codex, …) are usually only reachable through
 * the login shell. This module is the single place that knows how to recover
 * them, shared by the session resume executor and the Claude Code model
 * provider — neither may deep-import the other's module.
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/** Cached login-shell PATH (macOS/Linux GUI apps don't inherit the shell PATH). */
let loginPathCache: string | null | undefined;

function pathDirectories(pathValue: string): string[] {
  return pathValue.split(delimiter).filter(Boolean);
}

async function findExecutableInPath(
  file: string,
  pathValue: string,
): Promise<string | null> {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const directory of pathDirectories(pathValue)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${file}${extension.toLowerCase()}`);
      try {
        await access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

async function loginShellPath(): Promise<string | null> {
  if (loginPathCache !== undefined) return loginPathCache;
  loginPathCache = null;
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const value = await new Promise<string | null>((resolve) => {
      execFile(
        shell,
        ["-lc", "printf '%s' \"$PATH\""],
        { timeout: 5000, windowsHide: true },
        (error, stdout) => resolve(error ? null : stdout.trim()),
      );
    });
    if (value) loginPathCache = value;
  } catch {
    // keep the cached null fallback
  }
  return loginPathCache;
}

/**
 * Resolve an executable that may be missing from the GUI-launched process
 * PATH. Returns the file unchanged when it is a path or already resolvable —
 * otherwise the login-shell PATH is consulted and the absolute path returned.
 */
export async function resolveExecutableForLaunch(
  file: string,
): Promise<string> {
  if (isAbsolute(file) || file.includes("/") || file.includes("\\"))
    return file;
  if (await findExecutableInPath(file, process.env.PATH ?? "")) return file;
  const loginPath = await loginShellPath();
  const resolved = loginPath
    ? await findExecutableInPath(file, loginPath)
    : null;
  return resolved ?? file;
}
