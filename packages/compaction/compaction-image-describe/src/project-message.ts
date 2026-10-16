/** Immutable application of the image occurrences recorded by image/describe. */

import type { Message } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** One occurrence selection inside a single message. */
export interface MessageDescribeTarget {
  /** Zero-based depth-first image index within the immutable message. */
  readonly imageIndex: number
  /** Verbatim description text recorded for the occurrence. */
  readonly description: string
}

/**
 * Project selected image occurrences to immutable described blocks.
 * @param message - message projected before this decision.
 * @param targets - one entry per selected occurrence, image indexes strictly increasing.
 * @returns an immutable message with the same identity and selected images carrying their description.
 * @throws when a selected occurrence is missing, already described, or already offloaded.
 */
export function describeMessageImages(message: Message, targets: readonly MessageDescribeTarget[]): Message {
  let imageIndex = 0
  let selected = 0
  const visit = (blocks: readonly ContentBlock[]): ContentBlock[] => {
    let next: ContentBlock[] | undefined
    for (const [index, block] of blocks.entries()) {
      let projected = block
      if (block.type === 'image') {
        const target = selected < targets.length ? targets[selected] : undefined
        if (target !== undefined && imageIndex === target.imageIndex) {
          if (block.offloaded === true) {
            throw new Error(`image/describe: image index ${imageIndex} is already offloaded`)
          }
          if (block.description !== undefined) {
            throw new Error(`image/describe: image index ${imageIndex} is already described`)
          }
          projected = { ...block, description: target.description }
          selected += 1
        }
        imageIndex += 1
      }
      if (projected !== block) next ??= blocks.slice(0, index)
      next?.push(projected)
    }
    return next ?? blocks as ContentBlock[]
  }
  const content = visit(message.content)
  if (selected !== targets.length) {
    throw new Error(`image/describe: image index ${targets[selected]?.imageIndex} does not exist`)
  }
  return deepFreeze({ ...message, content })
}
