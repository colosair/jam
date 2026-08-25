import {
  readRuntimeConfig,
  resolveRuntime,
  runtimeConfigPath,
  writeRuntimeConfig,
  LauncherError,
  type ResolvedRuntime,
} from "@jam-mcp/launcher";

export type RuntimeCommandOptions = {
  /** Injected by tests; defaults to the real user home. */
  home?: string;
  json?: boolean;
};

/**
 * `jam runtime` - inspect or change which JAM build this machine runs.
 *
 * The config module is imported from the launcher rather than reimplemented
 * here: the launcher reads this file on every MCP start, so a second writer
 * with its own idea of the format is how the two drift apart.
 *
 * This command touches ~/.jam/config.yaml only. It never writes to a project.
 */
export function showRuntime(options: RuntimeCommandOptions = {}): number {
  const config = readRuntimeConfig(options.home);

  if (!config) {
    if (options.json) {
      writeJson({ status: "not_configured", code: "JAM_RUNTIME_CONFIG_MISSING" });
      return 1;
    }
    process.stdout.write("No JAM runtime is configured for this user.\n");
    process.stdout.write("\nRun:\n  jam runtime use package\n");
    return 1;
  }

  let resolved: ResolvedRuntime | undefined;
  let error: string | undefined;
  try {
    resolved = resolveRuntime(config);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (options.json) {
    writeJson({
      status: resolved ? "configured" : "invalid",
      mode: config.runtime.mode,
      ...(config.runtime.mode === "development" ? { source: config.runtime.source } : {}),
      ...(resolved ? { version: resolved.version } : {}),
      ...(error ? { error } : {}),
      configPath: runtimeConfigPath(options.home),
    });
    return resolved ? 0 : 1;
  }

  process.stdout.write(`Runtime: ${config.runtime.mode}\n`);
  if (config.runtime.mode === "development") {
    process.stdout.write(`Source:  ${config.runtime.source}\n`);
  }
  if (resolved) {
    process.stdout.write(`Version: ${resolved.version}\n`);
  } else {
    process.stdout.write(`\n[FAIL] ${error}\n`);
  }
  process.stdout.write(`Config:  ${runtimeConfigPath(options.home)}\n`);
  return resolved ? 0 : 1;
}

export function useRuntime(
  mode: string | undefined,
  source: string | undefined,
  options: RuntimeCommandOptions = {},
): number {
  if (mode === "package") {
    const path = writeRuntimeConfig({ version: 1, runtime: { mode: "package" } }, options.home);
    report({ mode: "package", path }, options);
    return 0;
  }

  if (mode === "development") {
    if (!source) {
      process.stderr.write("Usage: jam runtime use development <path-to-jam-checkout>\n");
      return 1;
    }
    // Validate before persisting, so a bad path fails here rather than on the
    // next MCP start where the error surfaces without context.
    try {
      resolveRuntime({ version: 1, runtime: { mode: "development", source } });
    } catch (err) {
      if (err instanceof LauncherError) {
        process.stderr.write(`[jam] ${err.code}: ${err.message}\n`);
        if (err.nextCommand) process.stderr.write(`\nRun:\n  ${err.nextCommand}\n`);
      } else {
        process.stderr.write(`[jam] ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return 1;
    }

    const path = writeRuntimeConfig(
      { version: 1, runtime: { mode: "development", source } },
      options.home,
    );
    report({ mode: "development", source, path }, options);
    return 0;
  }

  process.stderr.write("Usage: jam runtime use package | jam runtime use development <path>\n");
  return 1;
}

function report(
  result: { mode: string; source?: string; path: string },
  options: RuntimeCommandOptions,
): void {
  if (options.json) {
    writeJson({ status: "configured", ...result, configPath: result.path });
    return;
  }
  process.stdout.write(
    `Runtime set to ${result.mode}${result.source ? ` (${result.source})` : ""}.\n`,
  );
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
