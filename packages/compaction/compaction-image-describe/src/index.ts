/**
 * Durable image description executor for text-only routes. When the resolved
 * route declares no image input, the plugin describes every retained image
 * occurrence on the session's surface through the configured vision chain and
 * records the text in an `image/describe` surface fact, so the next derived
 * request carries the description in the image's place.
 *
 * @module @deepseek-ai/dsh-compaction-image-describe
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agent event map merge (`agent/request`).
import type {} from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { DescribeChain } from './chain.ts'
import { describeUndescribedImages } from './image-describe.ts'
import { imageDescribeProjection } from './projection.ts'
import type { ImageDescribeConfig, VisionRoute } from './types.ts'

export type { ImageDescribeConfig, ImageDescribeTarget, VisionRoute } from './types.ts'

export const name = 'compaction-image-describe'
export const inject = ['llm', 'sessions']

/**
 * Default instruction sent beside each described image. Perception and
 * reasoning stay separated: the vision route only reports what the image
 * shows, and the selected text model keeps the user's question and the full
 * conversation.
 */
export const DEFAULT_DESCRIBE_PROMPT = 'Describe this image completely and precisely for a text-only model that will never see it. Transcribe every piece of visible text verbatim, then name the layout, objects, people, colors, and any UI elements, diagrams, or annotations.'

/** Default cap on one description's character count. */
export const DEFAULT_MAX_DESCRIPTION_CHARS = 2048

/** Default per-route budget for one description before the route yields to the next. */
export const DEFAULT_DESCRIBE_TIMEOUT_MS = 45000

export const Config: z<ImageDescribeConfig> = z.object({
  visionRoutes: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).min(1),
  routeStrategy: z.union(['chain', 'same-provider']).default('chain'),
  describePrompt: z.string().default(DEFAULT_DESCRIBE_PROMPT),
  maxDescriptionChars: z.number().min(64).default(DEFAULT_MAX_DESCRIPTION_CHARS),
  describeTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DESCRIBE_TIMEOUT_MS),
})

/**
 * Install the durable description executor around request-config resolution.
 * @param ctx - plugin context that owns the projection and the config listener.
 * @param config - validated route chain and description bounds.
 */
export function apply(ctx: Context, config: ImageDescribeConfig): void {
  ctx.sessions.registerMessageProjection(imageDescribeProjection)

  // The advertised vision inventory is rebuilt lazily and dropped on every
  // registry change: registration at boot, retirement, and any settings swap
  // that re-registers a provider's routes.
  let inventory: Promise<readonly VisionRoute[]> | undefined
  const visionInventory = async (): Promise<readonly VisionRoute[]> => {
    if (inventory === undefined) {
      inventory = discoverVisionRoutes(ctx).then((routes) => {
        reportInventoryDrift(ctx.logger, config.visionRoutes, routes)
        return routes
      })
    }
    return inventory
  }
  ctx.on('llm/adapters-updated', () => {
    inventory = undefined
  }, { global: true })

  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const callConfig = await next()
    // Unlisted modalities pass images through to the adapter, matching the
    // runtime's own projection; only a route that declares text-only input
    // gets descriptions.
    const info = await ctx.llm.resolveModelInfo(callConfig.provider, callConfig.model, signal)
    if (info.inputModalities === undefined || info.inputModalities.includes('image')) return callConfig
    const chain: DescribeChain = {
      routes: config.visionRoutes,
      routeStrategy: config.routeStrategy,
      describePrompt: config.describePrompt,
      maxChars: config.maxDescriptionChars,
      describeTimeoutMs: config.describeTimeoutMs,
      selected: { provider: callConfig.provider, model: callConfig.model },
      signal,
      logger: ctx.logger,
      visionInventory,
      resolveModelInfo: (provider, model, chainSignal) => ctx.llm.resolveModelInfo(provider, model, chainSignal),
      stream: options => ctx.llm.stream(options),
    }
    await describeUndescribedImages(agent.session, chain)
    return callConfig
  })
}

/** Every route the live registry advertises as accepting image input. */
async function discoverVisionRoutes(ctx: Context): Promise<readonly VisionRoute[]> {
  const routes: VisionRoute[] = []
  for (const provider of ctx.llm.listProviders()) {
    let models: readonly LlmModelInfo[]
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch (error) {
      // One provider's catalog failing must not hide the rest; the chain's own
      // routes are validated per request through resolveModelInfo regardless.
      ctx.logger.warn(`image-describe: could not list models for provider ${provider.id}; skipped`, error)
      continue
    }
    for (const model of models) {
      if (model.inputModalities?.includes('image') === true) routes.push({ provider: provider.id, model: model.id })
    }
  }
  return [...routes].sort((left, right) => routeKey(left).localeCompare(routeKey(right)))
}

/** Report which advertised routes the chain ignores and which configured routes are unadvertised. */
function reportInventoryDrift(
  logger: Context['logger'],
  chain: readonly VisionRoute[],
  advertised: readonly VisionRoute[],
): void {
  const advertisedSet = new Set(advertised.map(routeKey))
  const unadvertised = chain.filter(route => !advertisedSet.has(routeKey(route)))
  if (unadvertised.length > 0) {
    logger.warn(`image-describe: configured chain routes the registry does not advertise as vision-capable (checked per request anyway): ${unadvertised.map(routeKey).join(', ')}`)
  }
  const chainSet = new Set(chain.map(routeKey))
  const unused = advertised.filter(route => !chainSet.has(routeKey(route)))
  if (unused.length > 0) {
    logger.info(`image-describe: vision-capable routes not in the chain (add them to visionRoutes to use them): ${unused.map(routeKey).join(', ')}`)
  }
}

function routeKey(route: VisionRoute): string {
  return `${route.provider}/${route.model}`
}
