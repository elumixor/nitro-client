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

interface WsRouteFile {
  urlPath: string;
  filePath: string;
  alias: string;
}

interface TreeNode {
  methods: Map<
    Method,
    { alias: string; typeStr: string; body?: string; query?: string; streamType?: string; streamReturnType?: string }
  >;
  ws?: { alias: string; sendType: string; receiveType: string };
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
      const m = name.match(/^(.+)\.(get|post|patch|put|delete|ws)\.ts$/);
      if (!m) continue;
      if (m[2] === "ws") continue; // WS routes handled by scanWsRoutes
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

function* scanWsRoutes(
  dir: string,
  urlPrefix = "",
  excludeDirs: Set<string>,
  excludeRoutes: Set<string>,
): Generator<WsRouteFile> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (excludeDirs.has(name)) continue;
      const seg = name.replace(/\[([^\]]+)\]/g, ":$1");
      yield* scanWsRoutes(full, `${urlPrefix}/${seg}`, excludeDirs, excludeRoutes);
    } else {
      const m = name.match(/^(.+)\.ws\.ts$/);
      if (!m) continue;
      const [, base] = m;
      const suffix = base === "index" ? "" : `/${(base ?? "").replace(/\[([^\]]+)\]/g, ":$1")}`;
      const urlPath = `${urlPrefix}${suffix}` || "/";
      const alias =
        "W" +
        urlPath
          .replace(/:([^/]+)/g, "_$1")
          .replace(/\//g, "_")
          .replace(/-/g, "_") +
        "_ws";
      if (excludeRoutes.has(urlPath)) continue;
      yield { urlPath, filePath: full, alias };
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
  wsRoutes: WsRouteFile[],
  wsTypeMap: Map<string, { send: string; receive: string }>,
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
  for (const wsRoute of wsRoutes) {
    const types = wsTypeMap.get(wsRoute.alias);
    const sendType = types?.send ?? "unknown";
    const receiveType = types?.receive ?? "unknown";
    let node = root;
    const segments = wsRoute.urlPath === "/" ? [] : wsRoute.urlPath.split("/").filter(Boolean);
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
    node.ws = { alias: wsRoute.alias, sendType, receiveType };
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

  if (node.ws) {
    const { sendType, receiveType } = node.ws;
    // Nitro serves WS handlers at path.ws — append .ws to the URL
    const wsUrl = `${urlExpr}.ws`;
    const fn = `() => doSocket<${sendType}, ${receiveType}>(\`${wsUrl}\`)`;
    const fnType = `() => Socket<${sendType}, ${receiveType}>`;
    const phantom = `$send: ${sendType}; $receive: ${receiveType}`;
    parts.push(`$ws: (${fn}) as unknown as (${fnType}) & { ${phantom} }`);
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
  const wsRoutes = [...scanWsRoutes(routesDir, "", excludeDirs, excludeRoutes)];
  console.log(`Found ${routes.length} routes, ${wsRoutes.length} WebSocket routes`);

  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
  });

  for (const route of routes) project.addSourceFileAtPath(route.filePath);
  for (const route of wsRoutes) project.addSourceFileAtPath(route.filePath);
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

  // Extract WebSocket send/receive types
  const wsTypeMap = new Map<string, { send: string; receive: string }>();
  for (const wsRoute of wsRoutes) {
    try {
      const sf = project.getSourceFileOrThrow(wsRoute.filePath);
      const defaultExports = sf.getExportedDeclarations().get("default");
      if (!defaultExports?.length) continue;
      const firstExport = defaultExports[0];
      if (!firstExport) continue;
      const declNode = firstExport.compilerNode;

      // wsHandler(schemas, fn) or wsHandler(fn) — extract inferred types from schema properties
      if (declNode.kind === ts.SyntaxKind.CallExpression) {
        const call = declNode as ts.CallExpression;
        if (call.arguments.length >= 2) {
          // First arg is the schemas object { send: {...}, receive: {...} }
          const schemasArg = call.arguments[0];
          if (schemasArg) {
            const schemasType = checker.getTypeAtLocation(schemasArg);

            // For each schema group (send/receive), resolve Zod output types from { key: ZodType }
            const resolveZodSchemaGroup = (propName: string): string => {
              const prop = schemasType.getProperty(propName);
              if (!prop) return "unknown";
              const objType = checker.getTypeOfSymbol(prop);
              const props = checker.getPropertiesOfType(objType);
              if (props.length === 0) return "Record<string, unknown>";
              const parts: string[] = [];
              for (const p of props) {
                const name = p.getName();
                if (name.startsWith("_")) continue;
                const zodType = checker.getTypeOfSymbol(p);
                // Zod v4: T["_zod"]["output"] gives the inferred output type
                const zodProp = zodType.getProperty("_zod");
                if (zodProp) {
                  const zodInternals = checker.getTypeOfSymbol(zodProp);
                  const outputProp = zodInternals.getProperty("output");
                  if (outputProp) {
                    parts.push(`${name}: ${serializeRawType(checker.getTypeOfSymbol(outputProp), checker)}`);
                    continue;
                  }
                }
                parts.push(`${name}: unknown`);
              }
              return `{ ${parts.join("; ")} }`;
            };

            const sendType = resolveZodSchemaGroup("send");
            const receiveType = resolveZodSchemaGroup("receive");
            wsTypeMap.set(wsRoute.alias, { send: sendType, receive: receiveType });
            console.log(`  ${wsRoute.alias} (ws): send=${sendType.slice(0, 50)}, receive=${receiveType.slice(0, 50)}`);
          }
        }
      }
    } catch (e) {
      console.warn(`  Warning: could not resolve WS types for ${wsRoute.alias}: ${(e as Error).message}`);
    }
  }

  const tree = buildTree(routes, typeMap, requestMap, streamMap, wsRoutes, wsTypeMap);
  const clientBody = genNode(tree, "");
  const hasWsRoutes = wsRoutes.length > 0;

  const socketClass = !hasWsRoutes
    ? ""
    : `
export class Socket<ServerMsg, ClientMsg> {
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  private readonly _ws: WebSocket;
  private readonly _buffer: ServerMsg[] = [];
  private readonly _waiters: Array<() => void> = [];
  private _done = false;
  private _nextIndex = 0;
  private readonly _resolveConnected: () => void;
  private readonly _rejectConnected: (err: Error) => void;
  private readonly _resolveClosed: () => void;

  constructor(baseUrl: string, path: string) {
    let wsUrl: string;
    if (baseUrl) {
      wsUrl = baseUrl.replace(/^http/, "ws") + path;
    } else if (typeof window !== "undefined") {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = proto + "//" + window.location.host + path;
    } else {
      wsUrl = "ws://localhost" + path;
    }
    this._ws = new WebSocket(wsUrl);
    const { promise: connected, resolve: resolveConnected, reject: rejectConnected } = Promise.withResolvers<void>();
    this.connected = connected;
    this._resolveConnected = resolveConnected;
    this._rejectConnected = rejectConnected;
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    this.closed = closed;
    this._resolveClosed = resolveClosed;
    this._ws.onopen = () => this._resolveConnected();
    this._ws.onerror = (e) => this._rejectConnected(new Error("WebSocket error"));
    this._ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(e.data as string); } catch { data = e.data; }
      this._buffer.push(data as ServerMsg);
      for (const w of this._waiters.splice(0)) w();
    };
    this._ws.onclose = () => {
      this._done = true;
      this._resolveClosed();
      for (const w of this._waiters.splice(0)) w();
    };
  }

  send(data: ClientMsg): void {
    this._ws.send(JSON.stringify(data));
  }

  close(code?: number, reason?: string): void {
    this._ws.close(code, reason);
  }

  next(): Promise<ServerMsg | undefined> {
    if (this._nextIndex < this._buffer.length) return Promise.resolve(this._buffer[this._nextIndex++]!);
    if (this._done) return Promise.resolve(undefined);
    return new Promise<ServerMsg | undefined>((resolve) => {
      this._waiters.push(() => {
        resolve(this._nextIndex < this._buffer.length ? this._buffer[this._nextIndex++]! : undefined);
      });
    });
  }

  [Symbol.asyncIterator](): AsyncGenerator<ServerMsg> {
    const self = this;
    let index = 0;
    return (async function* () {
      while (true) {
        if (index < self._buffer.length) { yield self._buffer[index++]!; continue; }
        if (self._done) return;
        await new Promise<void>((resolve) => {
          self._waiters.push(resolve);
        });
        if (index >= self._buffer.length && self._done) return;
      }
    })();
  }
}
`;

  const output = `\
// AUTO-GENERATED. DO NOT EDIT.
// Run 'bunx nitro-client' to regenerate.

type FetchFn = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export interface NitroAPIOptions {
  baseUrl: string;
  fetch?: FetchFn;
}
${socketClass}
export class Stream<E, R = void> {
  readonly done: Promise<R>;
  readonly id: Promise<string>;
  private readonly _resolveId: (value: string) => void;
  private readonly _rejectId: (err: Error) => void;
  private readonly _resolve: (value: R) => void;
  private readonly _reject: (err: Error) => void;
  private readonly _controller = new AbortController();
  private readonly _buffer: E[] = [];
  private readonly _waiters: Array<() => void> = [];
  private _returnValue: R | undefined;

  constructor(baseUrl: string, path: string, method: string, body: unknown, customFetch: FetchFn) {
    const { promise, resolve, reject } = Promise.withResolvers<R>();
    this.done = promise;
    this._resolve = resolve;
    this._reject = reject;
    const { promise: idPromise, resolve: resolveId, reject: rejectId } = Promise.withResolvers<string>();
    this.id = idPromise;
    this._resolveId = resolveId;
    this._rejectId = rejectId;
    void this._start(baseUrl, path, method, body, customFetch);
  }

  private async _start(baseUrl: string, path: string, method: string, body: unknown, customFetch: FetchFn): Promise<void> {
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
      if (err.name === "AbortError") { this._resolve(undefined as R); this._rejectId(err); return; }
      this._reject(err);
      this._rejectId(err);
      return;
    }
    if (!res.ok || !res.body) {
      const error = new Error(\`API error \${res.status}: \${await res.text().catch(() => "")}\`);
      this._reject(error);
      this._rejectId(error);
      return;
    }
    // If server returned JSON (not SSE), treat as immediate return value
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await res.text();
      try { this._returnValue = JSON.parse(text) as R; } catch { this._returnValue = text as R; }
      this._resolve(this._returnValue as R);
      for (const w of this._waiters.splice(0)) w();
      this.id.catch(() => {});
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
            const error = new Error(msg);
            this._reject(error);
            this._rejectId(error);
            currentEvent = "";
            return;
          }
          if (currentEvent === "__job") {
            this._resolveId((data as { id: string }).id);
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
      if (err.name !== "AbortError") { this._reject(err); this._rejectId(err); return; }
    } finally {
      reader.cancel();
    }
    this._resolve(this._returnValue !== undefined ? this._returnValue : undefined as R);
    for (const w of this._waiters.splice(0)) w();
    // Silence unhandled rejection if no job event was emitted
    this.id.catch(() => {});
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
  doStream: <E, R = void>(path: string, method: string, body?: unknown) => Stream<E, R>,${hasWsRoutes ? "\n  doSocket: <S, R>(path: string) => Socket<S, R>," : ""}
) {
  return ${clientBody};
}

class _NitroAPIBase {
  readonly $baseUrl: string;
  private readonly customFetch: FetchFn;

  constructor(options: NitroAPIOptions) {
    this.$baseUrl = options.baseUrl;
    this.customFetch = options.fetch ?? fetch.bind(globalThis);
    Object.assign(this, _buildRoutes(this.doFetch.bind(this), this.doStream.bind(this)${hasWsRoutes ? ", this.doSocket.bind(this)" : ""}));
  }

  doStream<E, R = void>(path: string, method: string, body?: unknown): Stream<E, R> {
    return new Stream<E, R>(this.$baseUrl, path, method, body, this.customFetch);
  }
${
  hasWsRoutes
    ? `
  doSocket<S, R>(path: string): Socket<S, R> {
    return new Socket<S, R>(this.$baseUrl, path);
  }
`
    : ""
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
