#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generate } from "./generate.ts";

function readNitroSrcDir(cwd: string): string | null {
  try {
    const content = readFileSync(join(cwd, "nitro.config.ts"), "utf-8");
    const match = content.match(/srcDir:\s*["']([^"']+)["']/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

const cwd = process.cwd();
const args = parseArgs(process.argv.slice(2));

const nitroSrcDir = readNitroSrcDir(cwd);
if (!nitroSrcDir && !args.src) {
  console.warn("Warning: nitro.config.ts not found or missing srcDir — defaulting to 'src'");
}

const srcDir = args.src ?? nitroSrcDir ?? "src";
const outDir = args.out ?? "generated/client";
const tsconfig = args.tsconfig ?? "tsconfig.json";

const routesDir = resolve(cwd, srcDir, "routes");
const outputFile = resolve(cwd, outDir, "index.ts");
const tsConfigFilePath = resolve(cwd, tsconfig);

const excludeDirs = new Set((args["exclude-dirs"] ?? "").split(",").filter(Boolean));
const excludeRoutes = new Set((args["exclude-routes"] ?? "").split(",").filter(Boolean));

await generate({ routesDir, outputFile, tsConfigFilePath, excludeDirs, excludeRoutes });
