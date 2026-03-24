import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Project, ts } from "ts-morph";

type Method = "get" | "post" | "patch" | "put" | "delete";

interface RouteFile {
  method: Method;
  urlPath: string;
  filePath: string;
  alias: string;
}

interface TreeNode {
  methods: Map<Method, { alias: string; typeStr: string; body?: string; query?: string }>;
  statics: Map<string, { origName: string; child: TreeNode }>;
  param: { name: string; child: TreeNode } | null;
}

export interface GenerateOptions {
  routesDir: string;
  outputFile: string;
  tsConfigFilePath: string;
  excludeDirs?: Set<string>;
  excludeRoutes?: Set<string>;
}

function* scanRoutes(
  dir: string,
  urlPrefix = "",
  excludeDirs: Set<string>,
  excludeRoutes: Set<string>,
): Generator<RouteFile> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (excludeDirs.has(name)) continue;
      const seg = name.replace(/\[([^\]]+)\]/g, ":$1");
      yield* scanRoutes(full, `${urlPrefix}/${seg}`, excludeDirs, excludeRoutes);
    } else {
      const m = name.match(/^(.+)\.(get|post|patch|put|delete)\.ts$/);
      if (!m) continue;
      const [, base, methodStr] = m;
      const method = methodStr as Method;
      const suffix = base === "index" ? "" : `/${(base ?? "").replace(/\[([^\]]+)\]/g, ":$1")}`;
      const urlPath = `${urlPrefix}${suffix}` || "/";
      const alias =
        "R" +
        urlPath
          .replace(/:([^/]+)/g, "_$1")
          .replace(/\//g, "_")
          .replace(/-/g, "_") +
        "_" +
        method;
      if (excludeRoutes.has(urlPath)) continue;
      yield { method, urlPath, filePath: full, alias };
    }
  }
}

function serializeRawType(type: ts.Type, checker: ts.TypeChecker, depth = 0, seen = new Set<ts.Type>()): string {
  if (depth > 12) return "unknown";

  const flags = type.flags;

  if (flags & ts.TypeFlags.String) return "string";
  if (flags & ts.TypeFlags.Number) return "number";
  if (flags & ts.TypeFlags.Boolean) return "boolean";
  if (flags & ts.TypeFlags.Null) return "null";
  if (flags & ts.TypeFlags.Undefined) return "undefined";
  if (flags & ts.TypeFlags.Void) return "void";
  if (flags & ts.TypeFlags.Unknown) return "unknown";
  if (flags & ts.TypeFlags.Never) return "never";
  if (flags & ts.TypeFlags.Any) return "unknown";

  if (flags & ts.TypeFlags.StringLiteral) return JSON.stringify((type as ts.StringLiteralType).value);
  if (flags & ts.TypeFlags.NumberLiteral) return String((type as ts.NumberLiteralType).value);
  if (flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type);

  if (flags & ts.TypeFlags.Union) {
    const parts = (type as ts.UnionType).types.map((t) => serializeRawType(t, checker, depth + 1, seen));
    return [...new Set(parts)].join(" | ");
  }

  if (flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.map((t) => serializeRawType(t, checker, depth + 1, seen)).join(" & ");
  }

  if (flags & ts.TypeFlags.Object) {
    const sym = type.getSymbol();
    const symName = sym?.getName();

    if (symName === "Date" || symName === "Decimal" || symName === "Buffer") return "string";
    if (symName === "Response" || symName === "ReadableStream") return "unknown";

    if (checker.isArrayType(type)) {
      const elem = checker.getTypeArguments(type as ts.TypeReference)[0];
      return elem ? `Array<${serializeRawType(elem, checker, depth + 1, seen)}>` : "Array<unknown>";
    }

    if (seen.has(type)) return "unknown";
    seen.add(type);

    const props = checker.getPropertiesOfType(type);

    if (props.length === 0) {
      seen.delete(type);
      return "Record<string, unknown>";
    }

    const propStrs = props
      .map((sym) => {
        const name = sym.getName();
        if (name.startsWith("__") || name.startsWith("$")) return null;
        const propType = checker.getTypeOfSymbol(sym);
        const isOpt = !!(sym.flags & ts.SymbolFlags.Optional);
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
        return `${key}${isOpt ? "?" : ""}: ${serializeRawType(propType, checker, depth + 1, seen)}`;
      })
      .filter(Boolean);

    seen.delete(type);
    return `{ ${propStrs.join("; ")} }`;
  }

  const text = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  if (/^[a-z]/.test(text)) return text;
  return "unknown";
}

function makeNode(): TreeNode {
  return { methods: new Map(), statics: new Map(), param: null };
}

function toCamel(s: string) {
  return s.replace(/-([a-z])/g, (_, c) => (c as string).toUpperCase());
}

function buildTree(
  routes: RouteFile[],
  typeMap: Map<string, string>,
  requestMap: Map<string, { body?: string; query?: string }>,
): TreeNode {
  const root = makeNode();
  for (const route of routes) {
    const typeStr = typeMap.get(route.alias) ?? "unknown";
    const req = requestMap.get(route.alias);
    let node = root;
    const segments = route.urlPath === "/" ? [] : route.urlPath.split("/").filter(Boolean);
    for (const seg of segments) {
      if (seg.startsWith(":")) {
        const paramName = seg.slice(1);
        if (!node.param) node.param = { name: paramName, child: makeNode() };
        node = node.param.child;
      } else {
        const camelName = toCamel(seg);
        if (!node.statics.has(camelName)) node.statics.set(camelName, { origName: seg, child: makeNode() });
        node = node.statics.get(camelName)!.child;
      }
    }
    node.methods.set(route.method, { alias: route.alias, typeStr, ...req });
  }
  return root;
}

function genNode(node: TreeNode, urlExpr: string): string {
  const parts: string[] = [];

  for (const [method, { typeStr, body, query }] of node.methods) {
    const hasBody = !["get"].includes(method);
    const fn = hasBody
      ? `(body?: unknown) => doFetch<${typeStr}>(\`${urlExpr}\`, "${method.toUpperCase()}", body)`
      : `() => doFetch<${typeStr}>(\`${urlExpr}\`, "${method.toUpperCase()}")`;
    const fnType = hasBody ? `(body?: unknown) => Promise<${typeStr}>` : `() => Promise<${typeStr}>`;
    const phantom: string[] = [`$response: ${typeStr}`];
    const requestParts: string[] = [];
    if (body) requestParts.push(`body: ${body}`);
    if (query) requestParts.push(`query: ${query}`);
    if (requestParts.length > 0) phantom.push(`$request: { ${requestParts.join("; ")} }`);
    parts.push(`$${method}: (${fn}) as unknown as (${fnType}) & { ${phantom.join("; ")} }`);
  }

  for (const [camelName, { origName, child }] of node.statics)
    parts.push(`${camelName}: ${genNode(child, `${urlExpr}/${origName}`)}`);

  const staticObj = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";

  if (!node.param) return staticObj;

  const { name: paramName, child } = node.param;
  const childUrl = `${urlExpr}/\${${paramName}}`;
  const callableFn = `(${paramName}: string) => (${genNode(child, childUrl)})`;

  if (parts.length === 0) return callableFn;
  return `Object.assign(${callableFn}, ${staticObj})`;
}

function collectReturnTypes(fn: ts.Node, checker: ts.TypeChecker): string[] | null {
  let body: ts.Node | undefined;
  if (fn.kind === ts.SyntaxKind.ArrowFunction || fn.kind === ts.SyntaxKind.FunctionExpression) {
    body = (fn as ts.ArrowFunction | ts.FunctionExpression).body;
  }
  if (!body || body.kind !== ts.SyntaxKind.Block) return null;

  const types: string[] = [];

  function visit(node: ts.Node, topLevel: boolean) {
    if (node.kind === ts.SyntaxKind.ReturnStatement) {
      if (!topLevel) return;
      const expr = (node as ts.ReturnStatement).expression;
      if (!expr) return;
      let retType = checker.getTypeAtLocation(expr);
      const sn = retType.getSymbol()?.getName() ?? "";
      if (sn.includes("Promise") || checker.getPropertiesOfType(retType).some((p) => p.getName() === "then")) {
        const args = checker.getTypeArguments(retType as ts.TypeReference);
        const first = args[0];
        if (first) retType = first;
      }
      types.push(serializeRawType(retType, checker));
      return;
    }
    const isNestedFn =
      node.kind === ts.SyntaxKind.FunctionDeclaration ||
      node.kind === ts.SyntaxKind.ArrowFunction ||
      node.kind === ts.SyntaxKind.FunctionExpression ||
      node.kind === ts.SyntaxKind.MethodDeclaration;
    ts.forEachChild(node, (child) => visit(child, topLevel && !isNestedFn));
  }

  visit(body, true);
  return types;
}

export function generate(options: GenerateOptions) {
  const { routesDir, outputFile, tsConfigFilePath } = options;
  const excludeDirs = options.excludeDirs ?? new Set<string>();
  const excludeRoutes = options.excludeRoutes ?? new Set<string>();

  const routes = [...scanRoutes(routesDir, "", excludeDirs, excludeRoutes)];
  console.log(`Found ${routes.length} routes`);

  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
  });

  for (const route of routes) project.addSourceFileAtPath(route.filePath);
  project.resolveSourceFileDependencies();

  const checker = project.getTypeChecker().compilerObject;

  const typeMap = new Map<string, string>();
  const requestMap = new Map<string, { body?: string; query?: string }>();

  for (const route of routes) {
    try {
      const sf = project.getSourceFileOrThrow(route.filePath);
      const defaultExports = sf.getExportedDeclarations().get("default");
      if (!defaultExports?.length) {
        typeMap.set(route.alias, "unknown");
        continue;
      }

      const firstExport = defaultExports[0];
      if (!firstExport) {
        typeMap.set(route.alias, "unknown");
        continue;
      }
      const declType = firstExport.getType().compilerType;
      const callSigs = checker.getSignaturesOfType(declType, ts.SignatureKind.Call);
      if (!callSigs.length) {
        typeMap.set(route.alias, "unknown");
        continue;
      }

      const declNode = firstExport.compilerNode;
      let typeStr: string | null = null;
      if (declNode.kind === ts.SyntaxKind.CallExpression) {
        const handlerCall = declNode as ts.CallExpression;
        const fnArg = handlerCall.arguments[handlerCall.arguments.length - 1];
        if (fnArg) {
          const stmtTypes = collectReturnTypes(fnArg, checker);
          if (stmtTypes && stmtTypes.length > 0) typeStr = [...new Set(stmtTypes)].join(" | ");
        }
      }

      if (!typeStr) {
        const sig = callSigs[0];
        if (!sig) {
          typeMap.set(route.alias, "unknown");
          continue;
        }
        let returnType = checker.getReturnTypeOfSignature(sig);
        const symName = returnType.getSymbol()?.getName() ?? "";
        if (
          symName.includes("Promise") ||
          checker.getPropertiesOfType(returnType).some((p) => p.getName() === "then")
        ) {
          const args = checker.getTypeArguments(returnType as ts.TypeReference);
          const first = args[0];
          if (first) returnType = first;
        }
        typeStr = serializeRawType(returnType, checker);
      }

      typeMap.set(route.alias, typeStr);
      console.log(`  ${route.alias}: ${typeStr.slice(0, 80)}...`);

      if (declNode.kind === ts.SyntaxKind.CallExpression) {
        const handlerCall = declNode as ts.CallExpression;
        if (handlerCall.arguments.length >= 2) {
          const fnArg = handlerCall.arguments[1];
          if (fnArg) {
            const fnType = checker.getTypeAtLocation(fnArg);
            const fnSigs = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call);
            const firstSig = fnSigs[0];
            if (firstSig) {
              const params = firstSig.getParameters();
              const firstParam = params[0];
              if (firstParam) {
                const contextType = checker.getTypeOfSymbol(firstParam);
                const req: { body?: string; query?: string } = {};
                const bodyProp = contextType.getProperty("body");
                if (bodyProp) req.body = serializeRawType(checker.getTypeOfSymbol(bodyProp), checker);
                const queryProp = contextType.getProperty("query");
                if (queryProp) req.query = serializeRawType(checker.getTypeOfSymbol(queryProp), checker);
                if (req.body ?? req.query) requestMap.set(route.alias, req);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`  Warning: could not resolve type for ${route.alias}: ${(e as Error).message}`);
      typeMap.set(route.alias, "unknown");
    }
  }

  const tree = buildTree(routes, typeMap, requestMap);
  const clientBody = genNode(tree, "");

  const output = `\
// AUTO-GENERATED. DO NOT EDIT.
// Run 'bunx nitro-client' to regenerate.

export interface NitroAPIOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

function _buildRoutes(doFetch: <T>(path: string, method: string, body?: unknown) => Promise<T>) {
  return ${clientBody};
}

class _NitroAPIBase {
  readonly $baseUrl: string;
  private readonly customFetch: typeof fetch;

  constructor(options: NitroAPIOptions) {
    this.$baseUrl = options.baseUrl;
    this.customFetch = options.fetch ?? fetch;
    Object.assign(this, _buildRoutes(this.doFetch.bind(this)));
  }

  private async doFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const res = await this.customFetch(\`\${this.$baseUrl}\${path}\`, {
      method,
      headers,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(\`API error \${res.status}: \${await res.text().catch(() => "")}\`);
    const text = await res.text();
    if (!text) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    return (ct.includes("application/json") ? JSON.parse(text) : text) as T;
  }
}

export const NitroAPI = _NitroAPIBase as unknown as new (options: NitroAPIOptions) => _NitroAPIBase & ReturnType<typeof _buildRoutes>;
export type NitroAPI = InstanceType<typeof NitroAPI>;
`;

  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, output);
  console.log(`\nGenerated: ${outputFile}`);
}
