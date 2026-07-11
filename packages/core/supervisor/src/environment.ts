import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runtime environment configuration for the supervisor.
 */
export interface RuntimeEnvironment {
  mode: "development" | "production";
  canHotReload: boolean;
  buildCommand: string | null;
}

/**
 * Auto-detect development vs production environment.
 * Checks for:
 * - tsx in node_modules (dev runner)
 * - tsconfig.json (TypeScript project)
 * - Build scripts in package.json
 */
export function detectEnvironment(cwd: string): RuntimeEnvironment {
  const tsxPath = join(cwd, "node_modules", ".bin", "tsx");
  const tsconfigPath = join(cwd, "tsconfig.json");
  
  const hasTsx = existsSync(tsxPath);
  const hasTsconfig = existsSync(tsconfigPath);
  
  // Check if we have a build command
  let buildCommand: string | null = null;
  if (hasTsconfig) {
    try {
      const pkgPath = join(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const pkgContent = readFileSync(pkgPath, "utf-8");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const pkg = JSON.parse(pkgContent);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
        const scripts = pkg.scripts as Record<string, string> | undefined;
        buildCommand = scripts?.build ?? scripts?.["build:all"] ?? null;
      }
    } catch {
      // Ignore errors
    }
  }
  
  const isDevelopment = hasTsx && hasTsconfig;
  
  return {
    mode: isDevelopment ? "development" : "production",
    canHotReload: isDevelopment && buildCommand !== null,
    buildCommand: isDevelopment ? buildCommand : null,
  };
}
