/**
 * Durable image description executor for text-only routes. When the agent's
 * configured route declares no image input, the plugin describes every
 * retained image of the incoming batch at admission — before the loop commits
 * it — and records the text on the image block itself, so the turn's first
 * request already carries the description in the image's place. A second
 * `agent/request` listener walks the whole session surface for occurrences
 * that reached it undescribed (an image-capable route that became text-only,
 * resume replay, a failed admission) and appends one `image/describe` decision
 * for them.
 *
 * @module @deepseek-ai/dsh-compaction-image-describe
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agent type and event map merges (`agent/pre-step`, `agent/request`).
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { isRetainedImage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { DescribeChain } from './chain.ts'
import { describeAdmittedImages } from './admission.ts'
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
 * Install the durable description executor around batch admission and
 * request-config resolution.
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

  const describeChain = (selected: { provider: string; model: string }, signal: AbortSignal | undefined): DescribeChain => ({
    routes: config.visionRoutes,
    routeStrategy: config.routeStrategy,
    describePrompt: config.describePrompt,
    maxChars: config.maxDescriptionChars,
    describeTimeoutMs: config.describeTimeoutMs,
    selected,
    signal,
    logger: ctx.logger,
    visionInventory,
    resolveModelInfo: (provider, model, chainSignal) => ctx.llm.resolveModelInfo(provider, model, chainSignal),
    stream: options => ctx.llm.stream(options),
  })

  // Admission describes the incoming batch before the loop commits it, so the
  // turn's first request already carries the descriptions. Admission consults
  // the agent's configured route (the last logged one when creation left the
  // pair to the request waterfall): the request waterfall that resolves the
  // final route runs after the batch commits.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (!decision.messages.some(message => message.content.some(
      block => block.type === 'image' && isRetainedImage(block)))) return decision
    const route = admissionRoute(agent)
    if (route === undefined) return decision
    let wantsDescriptions: boolean
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      // Unlisted modalities pass images through to the adapter, matching the
      // runtime's own projection; only a route that declares text-only input
      // gets descriptions.
      wantsDescriptions = info.inputModalities !== undefined && !info.inputModalities.includes('image')
    } catch (error: unknown) {
      // The gate resolves before the loop's own call preparation; a route that
      // fails here fails the request loud moments later without this attribution.
      ctx.logger.warn('image-describe: could not resolve the admitted route before the request; the batch stays as admitted', error)
      return decision
    }
    if (!wantsDescriptions) return decision
    const described = await describeAdmittedImages(decision.messages, describeChain(route, signal))
    return described === decision.messages ? decision : { ...decision, messages: [...described] }
  })

  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const callConfig = await next()
    // Unlisted modalities pass images through to the adapter, matching the
    // runtime's own projection; only a route that declares text-only input
    // gets descriptions.
    const info = await ctx.llm.resolveModelInfo(callConfig.provider, callConfig.model, signal)
    if (info.inputModalities === undefined || info.inputModalities.includes('image')) return callConfig
    await describeUndescribedImages(agent.session, describeChain(callConfig, signal))
    return callConfig
  })
}

/** The route whose modalities gate admission: the agent's configured pair, or the last logged request's. */
function admissionRoute(agent: Agent): { provider: string; model: string } | undefined {
  if (agent.options.provider && agent.options.model) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  const last = agent.session.requestHeader()?.config
  if (last === undefined || !last.provider || !last.model) return undefined
  return { provider: last.provider, model: last.model }
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
