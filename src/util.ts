import { codeFrameColumns } from '@babel/code-frame';
import {
  ValueNode as JsonValueNode,
  evaluate,
  parse,
} from '@humanwhocodes/momoa';
import AjvModule, { Schema } from 'ajv';
import AjvFormatsModule from 'ajv-formats';
import chalk from 'chalk';
import debugConstructor from 'debug';
import { XMLParser } from 'fast-xml-parser';
import { removeSync } from 'fs-extra/esm';
import StreamZip from 'node-stream-zip';
import fs from 'node:fs';
import readline from 'node:readline';
import util from 'node:util';
import oraConstructor from 'ora';
import tmp from 'tmp';
import upath from 'upath';
import { BaseIssue } from 'valibot';
import {
  publicationSchema,
  publicationSchemas,
} from './schema/pub-manifest.js';
import type { PublicationManifest } from './schema/publication.schema.js';

export const debug = debugConstructor('vs-cli');
export const cwd = upath.normalize(process.cwd());

const ora = oraConstructor({
  color: 'blue',
  spinner: 'circle',
  // Prevent stream output in docker so that not to spawn process
  // In other environment, check TTY context
  isEnabled: isInContainer() ? false : undefined,
});

export let beforeExitHandlers: (() => void)[] = [];
export function runExitHandlers() {
  while (beforeExitHandlers.length) {
    try {
      beforeExitHandlers.shift()?.();
    } catch (e) {
      // NOOP
    }
  }
}

const exitSignals = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'];
exitSignals.forEach((sig) => {
  process.on(sig, () => {
    runExitHandlers();
    if (sig !== 'exit') {
      process.exit(1);
    }
  });
});

if (process.platform === 'win32') {
  // Windows does not support signals, so use readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on('SIGINT', () => {
    runExitHandlers();
    process.exit(1);
  });
  beforeExitHandlers.push(() => {
    rl.close();
  });
}

/**
 * 0: silent
 * 1: info
 * 2: verbose
 * 3: debug
 */
let logLevel: 0 | 1 | 2 | 3 = 0;
export function setLogLevel(level?: 'silent' | 'info' | 'verbose' | 'debug') {
  if (!level) {
    return;
  }
  logLevel = {
    silent: 0 as const,
    info: 1 as const,
    verbose: 2 as const,
    debug: 3 as const,
  }[level];
  if (logLevel >= 3) {
    debugConstructor.enable('vs-cli');
  }
}

/**
 * @returns A function that stops logging
 */
export function startLogging(text?: string): typeof stopLogging {
  if (logLevel < 1) {
    return () => {};
  }
  // If text is not set, erase previous log with space character
  ora.start(text ?? ' ');
  return stopLogging;
}

/**
 * @returns A function that starts logging again
 */
export function suspendLogging(
  text?: string,
  symbol?: string,
): (text?: string) => void {
  if (logLevel < 1) {
    return () => {};
  }
  const { isSpinning, text: previousLoggingText } = ora;
  stopLogging(text, symbol);
  return (text) => {
    isSpinning ? startLogging(text || previousLoggingText) : ora.info(text);
  };
}

// NOTE: This function is intended to be used in conjunction with startLogging function,
// so it is not intentionally exported.
function stopLogging(text?: string, symbol?: string) {
  if (logLevel < 1) {
    return;
  }
  if (!text) {
    ora.stop();
    return;
  }
  ora.stopAndPersist({ text, symbol });
}

export function log(...obj: any) {
  if (logLevel < 1) {
    return;
  }
  console.log(...obj);
}

export function logUpdate(...obj: string[]) {
  if (logLevel < 1) {
    return;
  }
  if (ora.isSpinning) {
    ora.text = obj.join(' ');
  } else {
    ora.info(obj.join(' '));
  }
}

export function logSuccess(...obj: string[]) {
  if (logLevel < 1) {
    return;
  }
  const { isSpinning, text } = ora;
  ora.succeed(obj.join(' '));
  if (isSpinning) {
    startLogging(text);
  }
}

export function logError(...obj: string[]) {
  if (logLevel < 1) {
    return;
  }
  const { isSpinning, text } = ora;
  ora.fail(obj.join(' '));
  if (isSpinning) {
    startLogging(text);
  }
}

export function logWarn(...obj: string[]) {
  if (logLevel < 1) {
    return;
  }
  const { isSpinning, text } = ora;
  ora.warn(obj.join(' '));
  if (isSpinning) {
    startLogging(text);
  }
}

export function logInfo(...obj: string[]) {
  if (logLevel < 1) {
    return;
  }
  const { isSpinning, text } = ora;
  ora.info(obj.join(' '));
  if (isSpinning) {
    startLogging(text);
  }
}

export class DetailError extends Error {
  constructor(
    message: string | undefined,
    public detail: string | undefined,
  ) {
    super(message);
  }
}

export function getFormattedError(err: Error) {
  return err instanceof DetailError
    ? `${chalk.red.bold('Error:')} ${err.message}\n${err.detail}`
    : err.stack
      ? err.stack.replace(/^\w*Error:/, (v) => chalk.red.bold(v))
      : `${chalk.red.bold('Error:')} ${err.message}`;
}

export function gracefulError(err: Error) {
  const message = getFormattedError(err);

  if (ora.isSpinning) {
    ora.fail(message);
  } else {
    console.error(message);
  }
  console.log(
    chalk.gray(`
If you think this is a bug, please report at https://github.com/vivliostyle/vivliostyle-cli/issues`),
  );

  process.exit(1);
}

export function readJSON(path: string) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    return undefined;
  }
}

export function statFileSync(
  filePath: string,
  {
    errorMessage = 'Specified input does not exist',
  }: { errorMessage?: string } = {},
) {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    if ((err as any).code === 'ENOENT') {
      throw new Error(`${errorMessage}: ${filePath}`);
    }
    throw err;
  }
}

export async function inflateZip(filePath: string, dest: string) {
  return await new Promise<void>((res, rej) => {
    try {
      const zip = new StreamZip({
        file: filePath,
        storeEntries: true,
      });
      zip.on('error', (err) => {
        rej(err);
      });
      zip.on('ready', async () => {
        await util.promisify(zip.extract)(null, dest);
        await util.promisify(zip.close)();
        debug(`Unzipped ${filePath} to ${dest}`);
        res();
      });
    } catch (err) {
      rej(err);
    }
  });
}

export function useTmpDirectory(): Promise<[string, () => void]> {
  return new Promise<[string, () => void]>((res, rej) => {
    tmp.dir({ unsafeCleanup: true }, (err, path, clear) => {
      if (err) {
        return rej(err);
      }
      debug(`Created the temporary directory: ${path}`);
      const callback = () => {
        // clear function doesn't work well?
        // clear();
        removeSync(path);
        debug(`Removed the temporary directory: ${path}`);
      };
      beforeExitHandlers.push(callback);
      res([path, callback]);
    });
  });
}

export function touchTmpFile(path: string): () => void {
  fs.mkdirSync(upath.dirname(path), { recursive: true });
  // Create file if not exist
  fs.closeSync(fs.openSync(path, 'a'));
  debug(`Created the temporary file: ${path}`);
  const callback = () => {
    removeSync(path);
    debug(`Removed the temporary file: ${path}`);
  };
  beforeExitHandlers.push(callback);
  return callback;
}

export function pathEquals(path1: string, path2: string): boolean {
  return upath.relative(path1, path2) === '';
}

export function pathContains(parentPath: string, childPath: string): boolean {
  const rel = upath.relative(parentPath, childPath);
  return rel !== '' && !rel.startsWith('..');
}

export function isValidUri(str: string): boolean {
  return /^(https?|file|data):/i.test(str);
}

export function isInContainer(): boolean {
  return fs.existsSync('/opt/vivliostyle-cli/.vs-cli-version');
}

export async function openEpub(epubPath: string, tmpDir: string) {
  await inflateZip(epubPath, tmpDir);
  debug(`Created the temporary EPUB directory: ${tmpDir}`);
  const deleteEpub = () => {
    fs.rmSync(tmpDir, { recursive: true });
    debug(`Removed the temporary EPUB directory: ${tmpDir}`);
  };
  beforeExitHandlers.push(deleteEpub);
  return deleteEpub;
}

export function getDefaultEpubOpfPath(epubDir: string) {
  const containerXmlPath = upath.join(epubDir, 'META-INF/container.xml');
  const xmlParser = new XMLParser({
    ignoreAttributes: false,
  });
  const { container } = xmlParser.parse(
    fs.readFileSync(containerXmlPath, 'utf8'),
  );
  const rootfile = [container.rootfiles.rootfile].flat()[0]; // Only supports a default rendition
  const epubOpfPath = upath.join(epubDir, rootfile['@_full-path']);
  return epubOpfPath;
}

export function getEpubRootDir(epubOpfPath: string) {
  function traverse(dir: string) {
    const files = fs.readdirSync(dir);
    if (
      files.includes('META-INF') &&
      pathEquals(epubOpfPath, getDefaultEpubOpfPath(dir))
    ) {
      return dir;
    }
    const next = upath.dirname(dir);
    if (pathEquals(dir, next)) {
      return;
    }
    return traverse(next);
  }
  return traverse(upath.dirname(epubOpfPath));
}

// FIXME: https://github.com/ajv-validator/ajv/issues/2047
const Ajv = AjvModule.default;
const addFormats = AjvFormatsModule.default;

const getAjvValidatorFunction =
  <T extends Schema>(schema: T, refSchemas?: Schema | Schema[]) =>
  (obj: unknown): obj is T => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    if (refSchemas) {
      ajv.addSchema(refSchemas);
    }
    const validate = ajv.compile(schema);
    const valid = validate(obj);
    if (!valid) {
      throw validate.errors?.[0] || new Error();
    }
    return true;
  };

export const assertPubManifestSchema =
  getAjvValidatorFunction<PublicationManifest>(
    publicationSchema,
    publicationSchemas,
  );

export function parseJsonc(rawJsonc: string) {
  const ast = parse(rawJsonc, {
    mode: 'jsonc',
    ranges: false,
    tokens: false,
  });
  return evaluate(ast);
}

export function prettifySchemaError(
  rawJsonc: string,
  issues: BaseIssue<unknown>[],
) {
  const parsed = parse(rawJsonc, {
    mode: 'jsonc',
    ranges: false,
    tokens: false,
  });

  // Traverse to the deepest issue
  function traverse(issues: BaseIssue<unknown>[], depth: number) {
    return issues.flatMap((issue): [BaseIssue<unknown>[], number][] => {
      const p = issue.path?.length || 0;
      if (!issue.issues) {
        return [[[issue], depth + p]];
      }
      return traverse(issue.issues, depth + p).map(([i, d]) => [
        [issue, ...i],
        d,
      ]);
    });
  }
  const all = traverse(issues, 0);
  const maxDepth = Math.max(...all.map(([, d]) => d));
  const issuesTraversed = all.find(([, d]) => d === maxDepth)![0];

  let jsonValue = parsed.body as JsonValueNode;
  for (const p of issuesTraversed.flatMap((v) => v.path ?? [])) {
    let childValue: JsonValueNode | undefined;
    if (p.type === 'object' && jsonValue.type === 'Object') {
      childValue = jsonValue.members.find(
        (m) =>
          (m.name.type === 'Identifier' && m.name.name === p.key) ||
          (m.name.type === 'String' && m.name.value === p.key),
      )?.value;
    }
    if (p.type === 'array' && jsonValue.type === 'Array') {
      childValue = jsonValue.elements[p.key]?.value;
    }
    if (childValue) {
      jsonValue = childValue;
    } else {
      break;
    }
  }

  let message = `${chalk.red(issuesTraversed.at(-1)!.message)}`;
  if (jsonValue) {
    message += `\n${codeFrameColumns(rawJsonc, jsonValue.loc, {
      highlightCode: true,
    })}`;
  }
  return message;
}

export function writeFileIfChanged(filePath: string, content: Buffer) {
  if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(content)) {
    fs.mkdirSync(upath.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}
