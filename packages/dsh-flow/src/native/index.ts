import type { Context, Volatile } from '@deepseek-ai/cordis';
import '@deepseek-ai/cordis-plugin-loader';
import '@deepseek-ai/dsh-typert-registry';
import '@deepseek-ai/dsh-settings';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { createPlainConfigSchema, resolveConfig, type PlainConfig } from '../config.js';
import { FlowPlugin, inject as runtimeInject } from '../plugin.js';
import { FlowDashboardRemote, NativeConfiguration } from './host.js';
import { TYPERT as TYPERT_HOST } from './typert.host.js';

export const name = 'dsh-flow';
export const inject = [...runtimeInject, 'sessionQuery', 'typert'];
export const Config = createPlainConfigSchema().default({}).volatile();

export async function apply(ctx: Context, reference: Volatile<PlainConfig>): Promise<() => Promise<void>> {
  const current = (): PlainConfig => structuredClone(reference.get()) as PlainConfig;
  const runtime = await FlowPlugin.create(ctx, current());
  try {
    ctx.provide('flow', runtime);
    const configuration = new NativeConfiguration(runtime, ctx.fiber.entry?.options.id);
    ctx.on('internal/config', function(raw, next) { if (this === ctx.fiber) resolveConfig(raw); return next(); });
    ctx.on('loader/volatile-update', () => { configuration.apply(current()); });
    ctx.typert.register(TYPERT_HOST as TypertContribution);
    new FlowDashboardRemote(ctx, runtime, configuration);
    ctx.inject(['settings'], settingsContext => {
      settingsContext.effect(() => settingsContext.settings.configure({ profileInheritance: 'merge' }, ctx.fiber));
    });
    return () => runtime.dispose();
  } catch (error) { await runtime.dispose(); throw error; }
}
