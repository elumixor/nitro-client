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
  methods: Map<
    Method,
    { alias: string; typeStr: string; body?: string; query?: string; streamType?: string; streamReturnType?: string }
  >;
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
        // Skip optional props with type exactly `undefined` — these come from TypeScript
        // widening discriminated unions (e.g. `{ x?: undefined }` on variants that lack `x`)
        if (isOpt && propType.flags & ts.TypeFlags.Undefined) return null;
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
  streamMap: Map<string, { yield: string; return?: string }>,
): TreeNode {
  const root = makeNode();
  for (const route of routes) {
    const typeStr = typeMap.get(route.alias) ?? "unknown";
    const req = requestMap.get(route.alias);
    const stream = streamMap.get(route.alias);
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
        const staticNode = node.statics.get(camelName);
        if (!staticNode) throw new Error(`Missing static route node for segment ${seg}`);
        node = staticNode.child;
      }
    }
    node.methods.set(route.method, {
      alias: route.alias,
      typeStr,
      ...req,
      streamType: stream?.yield,
      streamReturnType: stream?.return,
    });
  }
  return root;
}

function genNode(node: TreeNode, urlExpr: string): string {
  const parts: string[] = [];

  for (const [method, { typeStr, body, query, streamType, streamReturnType }] of node.methods) {
    if (streamType) {
      // Streaming route: returns Stream instead of Promise
      const retPart = streamReturnType ? `, ${streamReturnType}` : "";
      const fn = `(body?: unknown) => doStream<${streamType}${retPart}>(\`${urlExpr}\`, "${method.toUpperCase()}", body)`;
      const fnType = `(body?: unknown) => Stream<${streamType}${retPart}>`;
      const responseType = streamReturnType ?? streamType;
      const phantom: string[] = [`$response: ${responseType}`, `$yield: ${streamType}`];
      const requestParts: string[] = [];
      if (body) requestParts.push(`body: ${body}`);
      if (query) requestParts.push(`query: ${query}`);
      if (requestParts.length > 0) phantom.push(`$request: { ${requestParts.join("; ")} }`);
      parts.push(`$${method}: (${fn}) as unknown as (${fnType}) & { ${phantom.join("; ")} }`);
    } else {
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
  }

  for (const [camelName, { origName, child }] of node.statics)
    parts.push(`${camelName}: ${genNode(child, `${urlExpr}/${origName}`)}`);

  const staticObj = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";

  if (!node.param) return staticObj;

  const { name: paramName, child } = node.param;
  const childUrl = `${urlExpr}/\${${paramName}}`;
  const innerNode = genNode(child, childUrl);

  // IIFE so we can reference ReturnType<typeof _fn> for the $param phantom
  // Enables: typeof api.things.$param.$get.$response
  const iife = `(() => { const _fn = (${paramName}: string) => (${innerNode}); return Object.assign(_fn, { ${[...parts, `$param: undefined as unknown as ReturnType<typeof _fn>`].join(", ")} }); })()`;

  return iife;
}

function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  const sn = type.getSymbol()?.getName() ?? "";
  const isThenable = sn.includes("Promise") || checker.getPropertiesOfType(type).some((p) => p.getName() === "then");
  if (!isThenable) return type;

  // Try direct type arguments first (works for standard Promise<T>)
  const args = checker.getTypeArguments(type as ts.TypeReference);
  if (args[0]) return args[0];

  // Fallback: extract resolved type from then() callback parameter
  // Works for PrismaPromise and other custom thenables
  const thenProp = type.getProperty("then");
  if (thenProp) {
    const thenType = checker.getTypeOfSymbol(thenProp);
    const thenSigs = checker.getSignaturesOfType(thenType, ts.SignatureKind.Call);
    const firstSig = thenSigs[0];
    if (firstSig) {
      const firstParam = firstSig.getParameters()[0];
      if (firstParam) {
        const cbType = checker.getTypeOfSymbol(firstParam);
        const cbSigs = checker.getSignaturesOfType(cbType, ts.SignatureKind.Call);
        const cbSig = cbSigs[0];
        if (cbSig) {
          const cbParams = cbSig.getParameters();
          if (cbParams[0]) return checker.getTypeOfSymbol(cbParams[0]);
        }
      }
    }
  }

  return type;
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
      retType = unwrapPromise(retType, checker);
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
  const streamMap = new Map<string, { yield: string; return?: string }>();

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
          // Check if it's an async generator function (has asteriskToken)
          const isGenerator =
            fnArg.kind === ts.SyntaxKind.FunctionExpression && !!(fnArg as ts.FunctionExpression).asteriskToken;

          if (isGenerator) {
            const fnType = checker.getTypeAtLocation(fnArg);
            const fnSigs = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call);
            const firstSig = fnSigs[0];
            if (firstSig) {
              const genReturnType = checker.getReturnTypeOfSignature(firstSig);
              const symName = genReturnType.getSymbol()?.getName() ?? "";
              if (symName === "AsyncGenerator" || symName === "Generator") {
                const typeArgs = checker.getTypeArguments(genReturnType as ts.TypeReference);
                const yieldType = typeArgs[0];
                if (yieldType) {
                  const yieldTypeStr = serializeRawType(yieldType, checker);
                  const returnType = typeArgs[1];
                  const returnTypeStr =
                    returnType && !(returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined))
                      ? serializeRawType(returnType, checker)
                      : undefined;
                  streamMap.set(route.alias, { yield: yieldTypeStr, return: returnTypeStr });
                  typeStr = yieldTypeStr;
                }
              }
            }
          } else {
            const stmtTypes = collectReturnTypes(fnArg, checker);
            if (stmtTypes && stmtTypes.length > 0) typeStr = [...new Set(stmtTypes)].join(" | ");
          }
        }
      }

      if (!typeStr) {
        const sig = callSigs[0];
        if (!sig) {
          typeMap.set(route.alias, "unknown");
          continue;
        }
        let returnType = checker.getReturnTypeOfSignature(sig);
        returnType = unwrapPromise(returnType, checker);
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

  const tree = buildTree(routes, typeMap, requestMap, streamMap);
  const clientBody = genNode(tree, "");

  const output = `\
// AUTO-GENERATED. DO NOT EDIT.
// Run 'bunx nitro-client' to regenerate.

export interface NitroAPIOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export class Stream<E, R = void> {
  readonly done: Promise<R>;
  jobId: string | undefined;
  private readonly _resolve: (value: R) => void;
  private readonly _reject: (err: Error) => void;
  private readonly _controller = new AbortController();
  private readonly _buffer: E[] = [];
  private readonly _waiters: Array<() => void> = [];
  private _returnValue: R | undefined;

  constructor(baseUrl: string, path: string, method: string, body: unknown, customFetch: typeof fetch) {
    const { promise, resolve, reject } = Promise.withResolvers<R>();
    this.done = promise;
    this._resolve = resolve;
    this._reject = reject;
    void this._start(baseUrl, path, method, body, customFetch);
  }

  private async _start(baseUrl: string, path: string, method: string, body: unknown, customFetch: typeof fetch): Promise<void> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await customFetch(\`\${baseUrl}\${path}\`, {
        method,
        headers,
        body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
        signal: this._controller.signal,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.name === "AbortError") { this._resolve(undefined as R); return; }
      this._reject(err);
      return;
    }
    if (!res.ok || !res.body) {
      this._reject(new Error(\`API error \${res.status}: \${await res.text().catch(() => "")}\`));
      return;
    }
    // If server returned JSON (not SSE), treat as immediate return value
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await res.text();
      try { this._returnValue = JSON.parse(text) as R; } catch { this._returnValue = text as R; }
      this._resolve(this._returnValue as R);
      for (const w of this._waiters.splice(0)) w();
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let currentEvent = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event:")) { currentEvent = line.slice(6).trim(); continue; }
          if (!line.startsWith("data:")) { if (line === "") currentEvent = ""; continue; }
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let data: unknown;
          try { data = JSON.parse(raw); } catch { data = raw; }
          if (currentEvent === "__error" || (data && typeof data === "object" && "__error" in data)) {
            const msg = currentEvent === "__error"
              ? (data as { message: string }).message
              : (data as { __error: string }).__error;
            this._reject(new Error(msg));
            currentEvent = "";
            return;
          }
          if (currentEvent === "__job") {
            this.jobId = (data as { id: string }).id;
            currentEvent = "";
            continue;
          }
          if (currentEvent === "__return") {
            this._returnValue = data as R;
            currentEvent = "";
            continue;
          }
          this._buffer.push(data as E);
          for (const w of this._waiters.splice(0)) w();
          currentEvent = "";
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.name !== "AbortError") { this._reject(err); return; }
    } finally {
      reader.cancel();
    }
    this._resolve(this._returnValue !== undefined ? this._returnValue : undefined as R);
    for (const w of this._waiters.splice(0)) w();
  }

  abort(): void { this._controller.abort(); }

  [Symbol.asyncIterator](): AsyncGenerator<E> {
    const self = this;
    let index = 0;
    return (async function* () {
      while (true) {
        if (index < self._buffer.length) { yield self._buffer[index++]!; continue; }
        await new Promise<void>((resolve) => {
          self._waiters.push(resolve);
          void self.done.then(() => resolve(), () => resolve());
        });
        if (index >= self._buffer.length) return;
      }
    })();
  }
}

function _buildRoutes(
  doFetch: <T>(path: string, method: string, body?: unknown) => Promise<T>,
  doStream: <E, R = void>(path: string, method: string, body?: unknown) => Stream<E, R>,
) {
  return ${clientBody};
}

class _NitroAPIBase {
  readonly $baseUrl: string;
  private readonly customFetch: typeof fetch;

  constructor(options: NitroAPIOptions) {
    this.$baseUrl = options.baseUrl;
    this.customFetch = options.fetch ?? fetch;
    Object.assign(this, _buildRoutes(this.doFetch.bind(this), this.doStream.bind(this)));
  }

  doStream<E, R = void>(path: string, method: string, body?: unknown): Stream<E, R> {
    return new Stream<E, R>(this.$baseUrl, path, method, body, this.customFetch);
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
