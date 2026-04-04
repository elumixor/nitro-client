#!/usr/bin/env bun
import { resolve } from "node:path";
import { readConfig } from "@elumixor/zod-config-cli";
import { z } from "zod";
import { generate } from "./generate";

const schema = z.object({
  src: z.string().default("src"),
  out: z.string().default("generated/client"),
  tsconfig: z.string().default("tsconfig.json"),
  excludeDirs: z.string().default(""),
  excludeRoutes: z.string().default(""),
});

const config = await readConfig({
  basename: "nitro-client.config",
  schema,
});

const cwd = process.cwd();
const routesDir = resolve(cwd, config.src, "routes");
const outputFile = resolve(cwd, config.out, "index.ts");
const tsConfigFilePath = resolve(cwd, config.tsconfig);

const excludeDirs = new Set(config.excludeDirs.split(",").filter(Boolean));
const excludeRoutes = new Set(config.excludeRoutes.split(",").filter(Boolean));

await generate({ routesDir, outputFile, tsConfigFilePath, excludeDirs, excludeRoutes });
