/** Describe the incoming batch's images before the loop commits them. */

import type { ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { isRetainedImage } from '@deepseek-ai/dsh-llm'
import type { DescribeChain } from './chain.ts'
import { describeImageThroughChain, resolveDescribeCandidates } from './chain.ts'

/**
 * Describe every retained image of the admitted batch through the configured
 * vision chain and return the messages with each described occurrence
 * carrying its description on the image block itself. One attachment is
 * described once and each of its occurrences receives the same text. An
 * attachment whose chain yields no description keeps its block unchanged, so
 * the deterministic placeholder still applies and the next request boundary
 * retries.
 * @param messages - the pre-step decision's admitted messages.
 * @param chain - the attempt's describe chain inputs.
 * @returns the same messages when nothing was described, otherwise rewritten messages.
 */
export async function describeAdmittedImages(
  messages: readonly UserMessage[],
  chain: DescribeChain,
): Promise<readonly UserMessage[]> {
  const pending = new Map<string, ImageBlock>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image' || !isRetainedImage(block)) continue
      const id = String(block.attachment.attachmentId)
      if (!pending.has(id)) pending.set(id, block)
    }
  }
  if (pending.size === 0) return messages

  const candidates = await resolveDescribeCandidates(chain)
  if (candidates.length === 0) return messages
  const descriptions = new Map<string, string>()
  for (const [id, block] of pending) {
    const description = await describeImageThroughChain(chain, candidates, block)
    if (description !== undefined) descriptions.set(id, description.text)
  }
  if (descriptions.size === 0) return messages

  const rewrite = (message: UserMessage): UserMessage => {
    const content = message.content.map((block) => {
      if (block.type !== 'image' || !isRetainedImage(block)) return block
      const description = descriptions.get(String(block.attachment.attachmentId))
      return description === undefined ? block : { ...block, description }
    })
    return content.some((block, index) => block !== message.content[index]) ? { ...message, content } : message
  }
  return messages.map(rewrite)
}
