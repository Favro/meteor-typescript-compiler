import * as ts from "typescript";
import { bold, dim, reset } from "chalk";
import * as path from "path";

/**
 * compiler-console (could not figure out how to load from separate file/module)
 * only got errors of type "packages/modules-runtime.js:222:12: Cannot find module 'compiler-console'"
 */

let traceEnabled = false;
let traceModuleRewrite = false;

/**
 * @returns undefined if enviroment variable is unset or an empty string,
 * false if the value is 0 or false and otherwise true
 */
function getBooleanEnvironmentVariable(key: string): boolean | undefined {
  const value = process.env[key]?.toLowerCase();
  if (!value) {
    return undefined;
  }
  // 0 or false => false
  return !["0", "false"].includes(value);
}

const failOnErrors = !!getBooleanEnvironmentVariable(
  "TYPESCRIPT_FAIL_ON_COMPILATION_ERRORS"
);

const forwardTypescriptErrors = getBooleanEnvironmentVariable(
  "TYPESCRIPT_FORWARD_TYPESCRIPT_ERRORS"
) ?? false;

const useBabelTransform = getBooleanEnvironmentVariable(
  "TYPESCRIPT_USE_BABEL_TRANSFORM"
) ?? false;

const sourceMapOverride = getBooleanEnvironmentVariable("TYPESCRIPT_SOURCEMAP");
// Determine if separate client/server compilation should be enabled.
// Priority:
// 1. Explicit environment variable TYPESCRIPT_SEPARATE_CLIENT_SERVER_COMPILATION
//    • "0" / "false"  -> false
//    • "1" / "true"   -> true
// 2. If env var is unset, enable when either tsconfig-client.json or tsconfig-server.json is present in cwd.

const separateCompilationEnv = getBooleanEnvironmentVariable(
  "TYPESCRIPT_SEPARATE_CLIENT_SERVER_COMPILATION"
);

const separateCompilation =
  separateCompilationEnv !== undefined
    ? separateCompilationEnv
    : ts.sys.fileExists("tsconfig-client.json") ||
      ts.sys.fileExists("tsconfig-server.json");

const transformAsyncAwait = getBooleanEnvironmentVariable(
  "TYPESCRIPT_TRANSFORM_ASYNC_AWAIT"
) ?? true;

export function setTraceEnabled(enabled: boolean) {
  traceEnabled = enabled;
}

export function error(msg: string, ...other: string[]) {
  process.stderr.write(bold.red(msg) + reset(other.join(" ")) + "\n");
}

export function warn(msg: string, ...other: string[]) {
  process.stderr.write(bold.yellow(msg) + reset(other.join(" ")) + "\n");
}

export function info(msg: string) {
  process.stdout.write(bold.green(msg) + dim(" ") + "\n");
}

export function trace(msg: string) {
  if (traceEnabled) {
    process.stdout.write(dim(msg) + dim(" ") + "\n");
  }
}

function _getCallStack(depth: number): string {
  const parts = (new Error().stack ?? "").split("\n");
  return "\n" + parts.slice(2, depth + 2).join("\n");
}

/**
 * Returns rounded to seconds with one decimal
 */
function msToSec(milliseconds: number) {
  return Math.round(milliseconds / 100) / 10;
}

/**
 * compiler-cache (could not figure out how to load from separate file/module)
 */
interface JavascriptData {
  source: string;
  fileName: string;
}

interface CacheData {
  javascript: JavascriptData;
  sourceMapJson: string | undefined;
}

interface JsCacheContent {
  type: "js";
  content: JavascriptData;
}
interface SourceMapCacheContent {
  type: "sourceMap";
  content: string;
}
type CacheContent = JsCacheContent | SourceMapCacheContent;

interface CacheContainer {
  sourceFilePath: string;
  content: CacheContent;
}

/**
 * Stores output from typescript on disk
 */
export class CompilerCache {
  constructor(public cachedFilesRoot: string) {}

  private getKey(sourceFilePath: string) {
    // Remove extension (.ts, .tsx)
    const parts = sourceFilePath.split(".");
    const result = parts.slice(0, parts.length - 1).join(".");
    return result;
  }

  private getContentPath(sourceFilePath: string, type: "js" | "sourceMap") {
    const key = this.getKey(sourceFilePath);
    const extension = type === "sourceMap" ? "js.map" : "js";
    const result = `${this.cachedFilesRoot}/${key}.${extension}`;
    return result;
  }

  private readContent(
    sourceFilePath: string,
    type: "js" | "sourceMap"
  ): CacheContent | undefined {
    const path = this.getContentPath(sourceFilePath, type);
    if (ts.sys.fileExists(path)) {
      const fileContents = ts.sys.readFile(path);
      if (!fileContents) {
        return undefined;
      }
      if (type === "js") {
        const filePath = this.getKey(sourceFilePath);
        const result: JsCacheContent = {
          type,
          content: {
            fileName: `${filePath}.js`,
            source: fileContents,
          },
        };
        return result;
      } else {
        return { type, content: fileContents };
      }
    }
    // Not finding sourcemaps is OK, they may be disabled
    if (type === "js") {
      error(`did not find ${path}`);
    }

    return undefined;
  }

  public writeEmittedFile(
    path: string,
    data: string,
    writeByteOrderMark: boolean
  ) {
    ts.sys.writeFile(path, data, writeByteOrderMark);
  }

  public get(sourceFilePath: string): CacheData | undefined {
    const jsData = this.getJavascript(sourceFilePath);
    if (!jsData) {
      return undefined;
    }
    const sourceMapJson = this.getSourceMap(sourceFilePath);
    return { javascript: jsData, sourceMapJson };
  }
  private getJavascript(sourceFilePath: string): JavascriptData | undefined {
    const content = this.readContent(sourceFilePath, "js");
    if (content?.type === "js") {
      return content.content;
    }
  }
  private getSourceMap(sourceFilePath: string): string | undefined {
    const content = this.readContent(sourceFilePath, "sourceMap");
    if (content?.type === "sourceMap") {
      return content.content;
    }
    return undefined;
  }
}

interface LocalEmitResult {
  fileName: string;
  data: string;
  sourceMap?: MeteorCompiler.SourceMap;
}

function isBare(inputFile: MeteorCompiler.InputFile): boolean {
  const fileOptions = inputFile.getFileOptions();
  return !!fileOptions?.bare;
}

function getRelativeFileName(filename: string, sourceRoot: string): string {
  if (sourceRoot && filename.startsWith(sourceRoot)) {
    return filename.substring(sourceRoot.length + 1);
  }
  return filename;
}

function getDiagnosticMessage(
  diagnostic: ts.Diagnostic,
  sourceRoot: string | undefined
): string {
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start
    );
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n"
    );
    return `${diagnostic.file.fileName}:${line + 1}:${character + 1}: ${message}`;
  }
  return ts.flattenDiagnosticMessageText(
    diagnostic.messageText,
    ts.sys.newLine
  );
}

/**
 * Creates a TypeScript transformer that rewrites import statements to use module suffixes
 * based on the tsconfig moduleSuffixes setting
 */
function createModuleSuffixTransformer(
  program: ts.Program
): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    const compilerOptions = program.getCompilerOptions();
    const moduleSuffixes = compilerOptions.moduleSuffixes || [];

    // Get all non-empty suffixes
    const nonEmptySuffixes = moduleSuffixes.filter(suffix => suffix !== "");

    if (nonEmptySuffixes.length === 0) {
      // No suffixes to apply, return identity transformer
      return (sourceFile: ts.SourceFile) => sourceFile;
    }

    // Pre-create module resolution host to avoid recreating it for each call
    const moduleResolutionHost = {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      trace: ts.sys.write,
      directoryExists: ts.sys.directoryExists,
      getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? (f: string) => f : (f: string) => f.toLowerCase()
    };

    return (sourceFile: ts.SourceFile) => {
      // Create a cache for resolved modules for this source file to avoid duplicate resolution
      const moduleResolutionCache = new Map<string, string>();

      const visit = (node: ts.Node): ts.Node => {
        // Handle import declarations: import ... from "module"
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const moduleSpecifier = node.moduleSpecifier.text;
          const rewrittenSpecifier = rewriteModuleSpecifier(
            moduleSpecifier,
            nonEmptySuffixes,
            compilerOptions,
            moduleResolutionHost,
            sourceFile,
            moduleResolutionCache
          );

          if (rewrittenSpecifier !== moduleSpecifier) {
            if (traceModuleRewrite)
              trace(`Rewriting import "${moduleSpecifier}" to "${rewrittenSpecifier}"`);
            return ts.factory.updateImportDeclaration(
              node,
              node.modifiers,
              node.importClause,
              ts.factory.createStringLiteral(rewrittenSpecifier),
              node.assertClause
            );
          }
        }

        // Handle export declarations: export ... from "module"
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const moduleSpecifier = node.moduleSpecifier.text;
          const rewrittenSpecifier = rewriteModuleSpecifier(
            moduleSpecifier,
            nonEmptySuffixes,
            compilerOptions,
            moduleResolutionHost,
            sourceFile,
            moduleResolutionCache
          );

          if (rewrittenSpecifier !== moduleSpecifier) {
            if (traceModuleRewrite)
              trace(`Rewriting export "${moduleSpecifier}" to "${rewrittenSpecifier}"`);
            return ts.factory.updateExportDeclaration(
              node,
              node.modifiers,
              node.isTypeOnly,
              node.exportClause,
              ts.factory.createStringLiteral(rewrittenSpecifier),
              node.assertClause
            );
          }
        }

        // Handle dynamic imports: import("module")
        if (ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0])) {
          const moduleSpecifier = node.arguments[0].text;
          const rewrittenSpecifier = rewriteModuleSpecifier(
            moduleSpecifier,
            nonEmptySuffixes,
            compilerOptions,
            moduleResolutionHost,
            sourceFile,
            moduleResolutionCache
          );

          if (rewrittenSpecifier !== moduleSpecifier) {
            if (traceModuleRewrite)
              trace(`Rewriting dynamic import "${moduleSpecifier}" to "${rewrittenSpecifier}"`);
            return ts.factory.updateCallExpression(
              node,
              node.expression,
              node.typeArguments,
              [ts.factory.createStringLiteral(rewrittenSpecifier)]
            );
          }
        }

        return ts.visitEachChild(node, visit, context);
      };

      return ts.visitNode(sourceFile, visit) as ts.SourceFile;
    };
  };
}

/**
 * Rewrites a module specifier to use the suffix that TypeScript resolved during module resolution
 */
function rewriteModuleSpecifier(
  moduleSpecifier: string,
  suffixes: string[],
  compilerOptions: ts.CompilerOptions,
  moduleResolutionHost: ts.ModuleResolutionHost,
  currentSourceFile: ts.SourceFile,
  moduleResolutionCache: Map<string, string>
): string {
  // Skip node_modules imports (but allow absolute paths starting with /)
  if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
    return moduleSpecifier;
  }

  // Check cache first
  const cacheKey = `${currentSourceFile.fileName}:${moduleSpecifier}`;
  if (moduleResolutionCache.has(cacheKey)) {
    return moduleResolutionCache.get(cacheKey)!;
  }

  let result = moduleSpecifier; // Default to original

  const resolved = ts.resolveModuleName(
    moduleSpecifier,
    currentSourceFile.fileName,
    compilerOptions,
    moduleResolutionHost
  );

  if (resolved.resolvedModule?.resolvedFileName) {
    const resolvedPath = resolved.resolvedModule.resolvedFileName;

    // Check if the resolved file has any of our suffixes
    for (const suffix of suffixes) {
      if (suffix && resolvedPath.includes(suffix)) {
        // Found a suffix in the resolved path, check if it's at the right position
        // (before the file extension)
        const withoutExt = resolvedPath.replace(/\.(ts|tsx|js|jsx)$/, '');
        if (withoutExt.endsWith(suffix)) {
          trace(`TypeScript resolved "${moduleSpecifier}" to "${resolvedPath}", applying suffix "${suffix}"`);
          result = moduleSpecifier + suffix;
          break;
        }
      }
    }
  }

  // Cache the result
  moduleResolutionCache.set(cacheKey, result);
  return result;
}

/**
 * Creates a TypeScript transformer that converts async/await to Meteor's Fiber-aware Promise methods.
 * This transformer is used on server-side code to convert:
 * - await something -> Promise.await(something)
 * - async function() { ... } -> function() { return Promise.try(() => { ... }); }
 */
function createAsyncAwaitTransformer(): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    const factory = context.factory;

    return (rootNode: ts.SourceFile) => {
      const visit = (node: ts.Node): ts.Node => {
        node = ts.visitEachChild(node, visit, context);

        if (ts.isAwaitExpression(node)) {
          // await something -> Promise.await(something)
          return factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier("Promise"),
              factory.createIdentifier("await")
            ),
            undefined,
            [node.expression]
          );
        }

        // async function() { ... } -> function() {
        //   return Promise.try(() => { ... });
        // }

        // Check if this node can have modifiers and has the async flag
        if (!ts.canHaveModifiers(node)) {
          return node;
        }

        const asyncFlag = ts.ModifierFlags.Async;
        const nodeFlags = ts.getCombinedModifierFlags(node as any);

        if ((nodeFlags & asyncFlag) === 0) {
          return node;
        }

        // Filter out async modifier
        const modifiers = ts.getModifiers(node as any);
        const modifiersWithoutAsync = modifiers?.filter(
          (modifier) => modifier.kind !== ts.SyntaxKind.AsyncKeyword
        );

        const promiseResultExpression = factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("Promise"),
            factory.createIdentifier("try")
          ),
          undefined,
          [
            factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              undefined,
              (node as any).body
            ),
          ]
        );

        const promiseResultBlock = factory.createBlock([
          factory.createReturnStatement(promiseResultExpression),
        ]);

        if (ts.isMethodDeclaration(node)) {
          return factory.updateMethodDeclaration(
            node,
            modifiersWithoutAsync,
            node.asteriskToken,
            node.name,
            node.questionToken,
            node.typeParameters,
            node.parameters,
            node.type,
            promiseResultBlock
          );
        } else if (ts.isFunctionExpression(node)) {
          return factory.updateFunctionExpression(
            node,
            modifiersWithoutAsync,
            node.asteriskToken,
            node.name,
            node.typeParameters,
            node.parameters,
            node.type,
            promiseResultBlock
          );
        } else if (ts.isArrowFunction(node)) {
          return factory.updateArrowFunction(
            node,
            modifiersWithoutAsync,
            node.typeParameters,
            node.parameters,
            node.type,
            node.equalsGreaterThanToken,
            promiseResultExpression
          );
        } else if (ts.isFunctionDeclaration(node)) {
          return factory.updateFunctionDeclaration(
            node,
            modifiersWithoutAsync,
            node.asteriskToken,
            node.name,
            node.typeParameters,
            node.parameters,
            node.type,
            promiseResultBlock
          );
        } else {
          // See "src/compiler/types.ts" for all possible node kinds.
          // Check replaceModifiers() in "src/compiler/factory/nodeFactory.ts" as an example on how to update nodes.
          warn(
            `Unexpected TypeScript node kind with async modifier: ${node.kind}, nodeFlags: ${nodeFlags}`
          );
          return node;
        }
      };

      return ts.visitNode(rootNode, visit) as ts.SourceFile;
    };
  };
}

type BuilderProgramType = ts.EmitAndSemanticDiagnosticsBuilderProgram;

type BuilderProgramOptions = Readonly<{
  program: BuilderProgramType;
  /**
   * Path to buildinfo file
   */
  buildInfoFile: string;
}>;

type WatcherInstance = {
  readonly watch: ts.Watch<BuilderProgramType>;
  /**
   * Path to buildinfo file
   */
  readonly buildInfoFile: string;
  readonly cache: CompilerCache;
  readonly getLastDiagnostics: () => ReadonlyArray<ts.Diagnostic>;
  readonly outDir: string;
};

export class MeteorTypescriptCompilerImpl extends BabelCompiler {
  private cachedWatchers: Map<string, WatcherInstance> = new Map();
  private numEmittedFiles = 0;
  private numStoredFiles = 0;
  private numCompiledFiles = 0;
  private numFilesFromCache = 0;
  private numFilesWritten = 0;
  private processStartTime = 0;

  /**
   * Used to inject the source map into the babel compilation
   * through the inferExtraBabelOptions override
   */
  private withSourceMap:
    | { sourceMap: MeteorCompiler.SourceMap; pathInPackage: string }
    | undefined = undefined;

  private cacheRoot = ".meteor/local/.typescript-incremental";

  constructor() {
    super({});
    setTraceEnabled(!!process.env.METEOR_TYPESCRIPT_TRACE_ENABLED);
  }

  reportWatchStatus(
    target: "server" | "client",
    diagnostic: ts.Diagnostic,
    _newLine: string,
    _options: ts.CompilerOptions,
    _errorCount?: number
  ) {
    this.writeDiagnostics(target, [diagnostic], undefined);
  }

  emitAllAffectedFiles(
    target: "server" | "client",
    program: BuilderProgramType,
    cache: CompilerCache,
    buildInfoFile: string,
    sourceRoot: string,
    outDir: string
  ) {
    const startTime = Date.now();
    this.clearStats();

    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(), // Get the diagnostics before emit to cache them in the buildInfo file.
    ];

    const writeIfBuildInfo = (
      fileName: string,
      data: string,
      writeByteOrderMark: boolean
    ): boolean => {
      if (fileName === buildInfoFile) {
        info(`Writing ${getRelativeFileName(buildInfoFile, sourceRoot)}`);
        cache.writeEmittedFile(fileName, data, writeByteOrderMark);
        return true;
      }
      return false;
    };

    /**
     * "emit" without a sourcefile will process all changed files, including the buildinfo file
     * so we need to write it out if it changed.
     * Then we can also tell which files were recompiled and put the data into the cache.
     */
    const transformers: ts.CustomTransformers = {
      before: [
        createModuleSuffixTransformer(program.getProgram()),
        ...(target === "server" && transformAsyncAwait ? [createAsyncAwaitTransformer()] : [])
      ]
    };

    const emitResult = program.emit(
      undefined,
      (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
        if (!writeIfBuildInfo(fileName, data, writeByteOrderMark)) {
          if (sourceFiles && sourceFiles.length > 0) {
            const relativeSourceFilePath = getRelativeFileName(
              sourceFiles[0].fileName,
              sourceRoot
            );


            // Recalculate fileName to avoid symlink issues
            const outputFileName = path.basename(fileName);
            const relativeDirPath = path.dirname(relativeSourceFilePath);
            const cleanFileName = path.join(
              outDir,
              relativeDirPath,
              outputFileName
            );

            if (fileName.match(/\.js$/)) {
              info(`Compiling ${relativeSourceFilePath}`);
              this.numCompiledFiles++;
              this.addJavascriptToCache(
                cleanFileName,
                data,
                writeByteOrderMark,
                cache
              );
            }
            if (fileName.match(/\.map$/)) {
              cache.writeEmittedFile(cleanFileName, data, writeByteOrderMark);
            }
          }
        }
      },
      undefined,
      undefined,
      transformers
    );

    const combinedDiagnostics = diagnostics.concat(emitResult.diagnostics);
    this.writeDiagnostics(target, combinedDiagnostics, sourceRoot);

    const endTime = Date.now();
    const delta = endTime - startTime;
    info(
      `Compilation finished in ${msToSec(delta)} seconds. ${
        this.numCompiledFiles
      } files were (re)compiled.`
    );
    return { diagnostics: combinedDiagnostics };
  }

  createWatcher(
    sourceRoot: string,
    target: "server" | "client"
  ): WatcherInstance {
    info(`Creating new Typescript watcher for ${sourceRoot} ${separateCompilation ? `(${target})` : ""}`);

    // Locate the most specific tsconfig file for this target (if enabled), falling back to the default one
    const configFileNames = separateCompilation
      ? target === "server"
        ? ["tsconfig-server.json", "tsconfig.json"]
        : ["tsconfig-client.json", "tsconfig.json"]
      : ["tsconfig.json"];
    let configPath: string | undefined;
    for (const fileName of configFileNames) {
      configPath = ts.findConfigFile(
        /*searchPath*/ "./",
        ts.sys.fileExists,
        fileName
      );
      if (configPath) {
        break;
      }
    }
    if (!configPath) {
      throw new Error(
        "Could not find a valid Typescript configuration file (tsconfig*.json)."
      );
    }

    // Important to make these paths absolute, see https://github.com/microsoft/TypeScript/issues/41690
    const cacheRootRelativeSource = this.cacheRoot.substring(
      this.cacheRoot.indexOf("/.meteor/local")
    );

    // Separate cache directories for client and server builds
    const rootOutDir = ts.sys.resolvePath(
      separateCompilation
        ? `${sourceRoot}${cacheRootRelativeSource}/${target}/v2cache`
        : `${sourceRoot}${cacheRootRelativeSource}/v2cache`
    );

    const outDir = `${rootOutDir}/out`;
    const buildInfoFile = `${rootOutDir}/buildfile.tsbuildinfo`;
    const cache = new CompilerCache(outDir);
    if (sourceMapOverride !== undefined) {
      info(`Overriding sourceMap setting to ${sourceMapOverride}`);
    }
    const optionsToExtend: ts.CompilerOptions = {
      incremental: true,
      tsBuildInfoFile: buildInfoFile,
      outDir,
      noEmit: false,
      ...(sourceMapOverride !== undefined
        ? { sourceMap: sourceMapOverride }
        : {}),
    };

    const watchHost = ts.createWatchCompilerHost(
      configPath,
      optionsToExtend,
      ts.sys,
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      (diagnostic) => this.writeDiagnostics(target, [diagnostic], sourceRoot),
      (...args) => this.reportWatchStatus(target, ...args)
    );

    let diagnostics: ReadonlyArray<ts.Diagnostic> = [];

    watchHost.afterProgramCreate = (program) => {
      ({ diagnostics } = this.emitAllAffectedFiles(
        target,
        program,
        cache,
        buildInfoFile,
        sourceRoot,
        outDir
      ));
    };

    const watch = ts.createWatchProgram(watchHost);
    return {
      buildInfoFile,
      watch,
      cache,
      getLastDiagnostics() {
        return diagnostics;
      },
      outDir,
    };
  }

  programFromWatcher({
    watch,
    buildInfoFile,
  }: WatcherInstance): BuilderProgramOptions {
    return {
      program: watch.getProgram(),
      buildInfoFile,
    };
  }

  /**
   * Gets from cache or creates a new program
   */
  getWatcherFor(
    directory: string,
    target: "server" | "client"
  ): WatcherInstance {
    const key = separateCompilation ? `${directory}:${target}` : directory;
    const foundInCache = this.cachedWatchers.get(key);
    if (foundInCache) {
      return foundInCache;
    }
    const newEntry = this.createWatcher(directory, target);
    this.cachedWatchers.set(key, newEntry);
    return newEntry;
  }

  /**
   * Invoked by the Meteor compiler framework
   */
  public setDiskCacheDirectory(path: string) {
    super.setDiskCacheDirectory(path);
    this.cacheRoot = path;
  }

  writeDiagnosticMessage(target: "server" | "client", message: string, category: ts.DiagnosticCategory) {
    switch (category) {
      case ts.DiagnosticCategory.Error:
        return error(`${message} [${target}]`);
      case ts.DiagnosticCategory.Warning:
      case ts.DiagnosticCategory.Suggestion:
      case ts.DiagnosticCategory.Message:
        return info(`${message} [${target}]`);
    }
  }

  writeDiagnostics(
    target: "server" | "client",
    diagnostics: ReadonlyArray<ts.Diagnostic>,
    sourceRoot: string | undefined
  ) {
    for (const diagnostic of diagnostics) {
      const message = getDiagnosticMessage(diagnostic, sourceRoot);
      this.writeDiagnosticMessage(target, message, diagnostic.category);
    }
  }

  /**
   * TBD in order to not force all projects to repeat the Meteor filename inclusion rules in the tsconfig.json
   * exclude section, we should filter out files here:
   *    Files in directories named "tests"
   *    Files specified in .meteorignore files
   *    other Meteor rules
   *
   * An alternative would be to provide a custom version of getFilesInDir
   * to the host parameter of getParsedCommandLineOfConfigFile
   */
  filterSourceFilenames(sourceFiles: string[]): string[] {
    return sourceFiles;
  }

  addJavascriptToCache(
    targetPath: string,
    data: string,
    writeByteOrderMark: boolean,
    cache: CompilerCache
  ) {
    this.numFilesWritten++;
    cache.writeEmittedFile(targetPath, data, writeByteOrderMark);
  }

  prepareSourceMap(
    sourceMapJson: string | undefined,
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile
  ): Object | undefined {
    if (!sourceMapJson) {
      return undefined;
    }
    const sourceMap: any = JSON.parse(sourceMapJson);
    sourceMap.sourcesContent = [sourceFile.text];
    const sourcePath = inputFile.getPathInPackage();
    sourceMap.sources = [sourcePath];
    return sourceMap;
  }

  emitResultFromCacheData(
    cacheData: CacheData,
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile
  ): LocalEmitResult {
    const {
      sourceMapJson,
      javascript: { fileName, source },
    } = cacheData;
    const sourceMap = this.prepareSourceMap(
      sourceMapJson,
      inputFile,
      sourceFile
    );
    return { data: source, sourceMap, fileName };
  }

  emitForSource(
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile,
    program: BuilderProgramType,
    cache: CompilerCache,
    target: "server" | "client",
    sourceRoot: string,
    outDir: string
  ): LocalEmitResult | undefined {
    this.numEmittedFiles++;

    trace(`Emitting Javascript for ${inputFile.getPathInPackage()}`);
    const transformers: ts.CustomTransformers = {
      before: [
        createModuleSuffixTransformer(program.getProgram()),
        ...(target === "server" && transformAsyncAwait ? [createAsyncAwaitTransformer()] : [])
      ]
    };

    program.emit(sourceFile, function (fileName, data, writeByteOrderMark) {
      // Recalculate fileName to avoid symlink issues
      const relativeSourceFilePath = getRelativeFileName(
        sourceFile.fileName,
        sourceRoot
      );
      const outputFileName = path.basename(fileName);
      const relativeDirPath = path.dirname(relativeSourceFilePath);
      const cleanFileName = path.join(
        outDir,
        relativeDirPath,
        outputFileName
      );
      cache.writeEmittedFile(cleanFileName, data, writeByteOrderMark);
    }, undefined, undefined, transformers);

    const sourcePath = inputFile.getPathInPackage();
    const compiledResult = cache.get(sourcePath);
    if (!compiledResult) {
      return undefined;
    }
    const result = this.emitResultFromCacheData(
      compiledResult,
      inputFile,
      sourceFile
    );
    return result;
  }

  getOutputForSource(
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile,
    program: BuilderProgramType,
    cache: CompilerCache,
    target: "server" | "client",
    sourceRoot: string,
    outDir: string
  ): LocalEmitResult | undefined {
    const fromCache = cache.get(inputFile.getPathInPackage());
    if (fromCache) {
      const result = this.emitResultFromCacheData(
        fromCache,
        inputFile,
        sourceFile
      );
      this.numFilesFromCache++;
      return result;
    }
    return this.emitForSource(inputFile, sourceFile, program, cache, target, sourceRoot, outDir);
  }

  public inferExtraBabelOptions(
    inputfile: MeteorCompiler.InputFile,
    babelOptions: any,
    cacheDeps: any
  ): boolean {
    if (
      this.withSourceMap &&
      inputfile.getPathInPackage() === this.withSourceMap.pathInPackage
    ) {
      // Ensure that the Babel compiler picks up our source maps
      babelOptions.inputSourceMap = this.withSourceMap.sourceMap;
    }
    return super.inferExtraBabelOptions(inputfile, babelOptions, cacheDeps);
  }

  emitResultFor(
    inputFile: MeteorCompiler.InputFile,
    program: BuilderProgramType,
    cache: CompilerCache,
    errors: ReadonlyArray<ts.Diagnostic>,
    target: string,
    sourceRoot: string,
    outDir: string
  ) {
    const inputFilePath = inputFile.getPathInPackage();
    const sourceFile =
      program.getSourceFile(inputFilePath) ||
      program.getSourceFile(ts.sys.resolvePath(inputFilePath));

    if (!sourceFile) {
      trace(`[${target}] Could not find source file for ${inputFilePath}`);
      return;
    }

    const errorsForFile = errors.filter(
      (error) => error.file?.fileName === sourceFile.fileName
    );
    if (errorsForFile.length > 0) {
      if (failOnErrors) {
        if (forwardTypescriptErrors) {
          const sourceRoot = inputFile.getSourceRoot(false);
          for (const diagnostic of errorsForFile) {
            if (diagnostic.file && diagnostic.start !== undefined) {
              const { line } = diagnostic.file.getLineAndCharacterOfPosition(
                diagnostic.start
              );
              inputFile.error({
                func: "",
                line,
                sourcePath: inputFilePath,
                message: getDiagnosticMessage(diagnostic, sourceRoot),
              });
            }
          }
        } else {
          inputFile.error({
            func: "",
            line: 0,
            sourcePath: "",
            message: "Check TypeScript errors",
          });
        }
      }
    }

    try {
      const sourcePath = inputFile.getPathInPackage();
      const bare = isBare(inputFile);
      const hash = inputFile.getSourceHash();
      inputFile.addJavaScript({ path: sourcePath, bare, hash }, () => {
        this.numStoredFiles++;
        const emitResult = this.getOutputForSource(
          inputFile,
          sourceFile,
          program,
          cache,
          target as "server" | "client",
          sourceRoot,
          outDir
        );
        if (!emitResult) {
          error(`Nothing emitted for ${inputFilePath}`);
          return {};
        }
        const { data, sourceMap } = emitResult;
        // To get Babel processing, we must invoke it ourselves via the
        // inherited BabelCompiler method processOneFileForTarget
        // To get the source map injected we override inferExtraBabelOptions
        if (useBabelTransform) {
          if (sourceMap) {
            this.withSourceMap = {
              sourceMap,
              pathInPackage: inputFilePath,
            };
          }

          const jsData = this.processOneFileForTarget(inputFile, data);
          // Use the same hash as in the deferred data
          return {
            ...jsData,
            hash,
          };
        }

        return {
          sourcePath: sourceFile,
          path: emitResult.fileName,
          data,
          hash,
          sourceMap
        }
      });
    } catch (e: any) {
      error(e.message);
    }
  }

  clearStats() {
    this.numEmittedFiles = 0;
    this.numFilesFromCache = 0;
    this.numFilesWritten = 0;
    this.numStoredFiles = 0;
    this.numCompiledFiles = 0;
    this.processStartTime = 0;
  }

  // Called by the compiler plugins system after all linking and lazy
  // compilation has finished. (bundler.js)
  afterLink() {
    if (this.numStoredFiles > 0) {
      const endTime = Date.now();
      const delta = endTime - this.processStartTime;
      info(
        `Typescript summary: ${msToSec(delta)} seconds for sending ${
          this.numStoredFiles
        } transpiled files on for bundling`
      );
      if (this.numEmittedFiles > 0) {
        warn(
          `${this.numEmittedFiles} files emitted ad-hoc (cache inconsistency)`
        );
      }
    }

    // Reset since this method gets called once for each resourceSlot
    this.clearStats();
  }

  processFilesForTarget(inputFiles: MeteorCompiler.InputFile[]) {
    if (inputFiles.length === 0) {
      return;
    }

    const firstInput = inputFiles[0];
    const sourceRoot =
      firstInput.getSourceRoot(false) || ts.sys.getCurrentDirectory();

    const arch = firstInput.getArch();
    const targetType: "server" | "client" = arch.startsWith("os.")
      ? "server"
      : "client";

    info(
      `Typescript processing requested for ${arch} (${targetType}) using Typescript ${ts.version}`+
        (separateCompilation ? " with separate compilation" : "")
    );

    const { watch, cache, getLastDiagnostics, outDir } = this.getWatcherFor(
      sourceRoot,
      targetType
    );
    // This both produces all dirty files and provides us an instance to emit ad-hoc in case a file went missing
    const program = watch.getProgram();

    this.clearStats();
    this.processStartTime = Date.now();

    const isCompilableFile = (f: MeteorCompiler.InputFile) => {
      const fileName = f.getBasename();
      const dirName = f.getDirname();
      return (
        !fileName.endsWith(".d.ts") &&
        !fileName.startsWith("tsconfig") &&
        // we really don't want to compile .ts files in node_modules but meteor will send them
        // anyway as input files. Adding node_modules to .meteorignore causes other runtime problems
        // so this is a somewhat ugly workaround
        !dirName.startsWith("node_modules/")
      );
    };
    const errors = getLastDiagnostics().filter(
      (d) => d.category === ts.DiagnosticCategory.Error
    );
    const compilableFiles = inputFiles.filter(isCompilableFile);
    for (const inputFile of compilableFiles) {
      this.emitResultFor(inputFile, program, cache, errors, targetType, sourceRoot, outDir);
    }
  }

  /**
   * Called by Meteor when this plugin is being replaced (e.g., during hot-reload).
   * Closes all TypeScript watch instances to prevent memory leaks.
   */
  dispose(): void {
    this.cachedWatchers.forEach((watcher) => {
      try {
        watcher.watch.close();
      } catch (e) {
        // Ignore errors during cleanup
      }
    });
    this.cachedWatchers.clear();
  }
}

// I haven't figured out how to use a proper export here
MeteorTypescriptCompiler = MeteorTypescriptCompilerImpl;
