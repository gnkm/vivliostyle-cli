import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import upath from 'upath';
import * as v from 'valibot';
import { Logger } from '../logger.js';
import {
  cwd as defaultRoot,
  DetailError,
  parseJsonc,
  prettifySchemaError,
} from '../util.js';
import {
  InlineOptions,
  ParsedVivliostyleConfigSchema,
  VivliostyleConfigSchema,
} from './schema.js';

const require = createRequire(import.meta.url);

export function locateVivliostyleConfig({
  config,
  cwd = defaultRoot,
}: Pick<InlineOptions, 'config' | 'cwd'>) {
  if (config) {
    return upath.resolve(cwd, config);
  }
  return ['.js', '.mjs', '.cjs', '.json']
    .map((ext) => upath.join(cwd, `vivliostyle.config${ext}`))
    .find((p) => fs.existsSync(p));
}

export async function loadVivliostyleConfig({
  config,
  configData,
  cwd,
}: Pick<InlineOptions, 'config' | 'configData' | 'cwd'>): Promise<
  ParsedVivliostyleConfigSchema | undefined
> {
  if (configData) {
    return v.parse(VivliostyleConfigSchema, configData);
  }

  const absPath = locateVivliostyleConfig({ config, cwd });
  if (!absPath) {
    return;
  }

  let parsedConfig: unknown;
  let jsonRaw: string | undefined;
  try {
    if (upath.extname(absPath) === '.json') {
      jsonRaw = fs.readFileSync(absPath, 'utf8');
      parsedConfig = parseJsonc(jsonRaw);
    } else {
      // Clear require cache to reload CJS config files
      delete require.cache[require.resolve(absPath)];
      const url = pathToFileURL(absPath);
      // Invalidate cache for ESM config files
      // https://github.com/nodejs/node/issues/49442
      url.search = `version=${Date.now()}`;
      parsedConfig = (await import(/* @vite-ignore */ url.href)).default;
      jsonRaw = JSON.stringify(parsedConfig, null, 2);
    }
  } catch (error) {
    const thrownError = error as Error;
    throw new DetailError(
      `An error occurred on loading a config file: ${absPath}`,
      thrownError.stack ?? thrownError.message,
    );
  }

  const result = v.safeParse(VivliostyleConfigSchema, parsedConfig);
  if (result.success) {
    const { tasks, inlineOptions } = result.output;
    return {
      tasks,
      inlineOptions: {
        ...inlineOptions,
        cwd: cwd ?? defaultRoot,
        config: absPath,
      },
    };
  } else {
    const errorString = prettifySchemaError(jsonRaw, result.issues);
    throw new DetailError(
      `Validation of vivliostyle config failed. Please check the schema: ${config}`,
      errorString,
    );
  }
}

export function warnDeprecatedConfig(config: ParsedVivliostyleConfigSchema) {
  if (config.tasks.some((task) => task.includeAssets)) {
    Logger.logWarn(
      "'includeAssets' property of Vivliostyle config was deprecated and will be removed in a future release. Please use 'copyAsset.includes' property instead.",
    );
  }

  if (config.tasks.some((task) => task.tocTitle)) {
    Logger.logWarn(
      "'tocTitle' property of Vivliostyle config was deprecated and will be removed in a future release. Please use 'toc.title' property instead.",
    );
  }

  if (config.tasks.some((task) => task.http)) {
    Logger.logWarn(
      "'http' property of Vivliostyle config was deprecated and will be removed in a future release. This option is enabled by default, and the file protocol is no longer supported.",
    );
  }
}
