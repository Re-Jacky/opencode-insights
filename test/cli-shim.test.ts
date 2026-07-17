import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createCliShimContent, ensureCliShim, resolveCliShimPath } from "../src/cli-shim.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cli shim", () => {
  test("resolves a user-local shim path", () => {
    expect(resolveCliShimPath({ homeDir: "/Users/alice", platform: "darwin" })).toBe("/Users/alice/.local/bin/opencode-insights");
    expect(resolveCliShimPath({ homeDir: "/Users/alice", platform: "win32" })).toBe("/Users/alice/.local/bin/opencode-insights.cmd");
  });

  test("creates an executable shim that runs the package CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-shim-"));
    cleanup.push(dir);
    const packageRoot = join(dir, "package");
    const cliPath = join(packageRoot, "dist", "cli.js");

    const result = await ensureCliShim({ homeDir: dir, packageRoot, platform: "darwin" });

    const shimPath = join(dir, ".local", "bin", "opencode-insights");
    expect(result).toEqual({ path: shimPath, status: "created" });
    expect(await readFile(shimPath, "utf8")).toBe(createCliShimContent(cliPath, "darwin"));
  });

  test("does not overwrite a user-owned command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-shim-"));
    cleanup.push(dir);
    const shimPath = join(dir, ".local", "bin", "opencode-insights");
    await mkdir(join(dir, ".local", "bin"), { recursive: true });
    await writeFile(shimPath, "#!/usr/bin/env sh\necho custom\n", "utf8");
    await chmod(shimPath, 0o755);

    const result = await ensureCliShim({ homeDir: dir, packageRoot: join(dir, "package"), platform: "darwin" });

    expect(result).toEqual({ path: shimPath, status: "skipped", reason: "existing command is not managed by opencode-insights" });
    expect(await readFile(shimPath, "utf8")).toBe("#!/usr/bin/env sh\necho custom\n");
  });

  test("updates a previously generated shim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-shim-"));
    cleanup.push(dir);
    const shimPath = join(dir, ".local", "bin", "opencode-insights");
    const oldRoot = join(dir, "old-package");
    const newRoot = join(dir, "new-package");

    const first = await ensureCliShim({ homeDir: dir, packageRoot: oldRoot, platform: "darwin" });
    const second = await ensureCliShim({ homeDir: dir, packageRoot: newRoot, platform: "darwin" });

    expect(first.status).toBe("created");
    expect(second).toEqual({ path: shimPath, status: "updated" });
    expect(await readFile(shimPath, "utf8")).toBe(createCliShimContent(join(newRoot, "dist", "cli.js"), "darwin"));
    expect(existsSync(shimPath)).toBe(true);
  });
});
