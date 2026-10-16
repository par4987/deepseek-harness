/** Config and target types for the durable image description executor.
 * @module @deepseek-ai/dsh-compaction-image-describe/types */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** One vision-capable route a description may be requested through. */
export interface VisionRoute {
  /** Provider id of the describing route. */
  readonly provider: string
  /** Model id of the describing route. */
  readonly model: string
}

/** Validated plugin configuration. */
export interface ImageDescribeConfig {
  /** Ordered describe chain; the first route that answers within its budget describes. */
  readonly visionRoutes: VisionRoute[]
  /** Route ordering strategy: the configured chain as given, or the selected route's own provider fronted first. */
  readonly routeStrategy: 'chain' | 'same-provider'
  /** Instruction sent beside each described image. */
  readonly describePrompt: string
  /** Cap on one description's character count. */
  readonly maxDescriptionChars: number
  /** Per-route budget for one description before the route yields to the next. */
  readonly describeTimeoutMs: number
}

/** One image occurrence and the description text recorded for it. */
export interface ImageDescribeTarget {
  /** Current message-producing event containing the occurrence. */
  readonly seq: SessionSeq
  /** Zero-based depth-first image index within the immutable message. */
  readonly imageIndex: number
  /** Verbatim description text a vision chain produced for the occurrence. */
  readonly description: string
}
