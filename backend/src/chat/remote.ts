import type { Conversation, Message } from '../domain/models';
import { reject } from '../problem';
import { isChatAction } from '../domain/chat.models';
import { messageSources } from '../domain/chat-sources';

/** The SQL API owns conversation persistence; the small AI Worker owns inference. */
export async function requestKassandra(
  endpoint: string | undefined,
  authorization: string,
  conversation: Conversation,
  content: string,
  context: unknown,
  signal?: AbortSignal,
): Promise<Pick<Message, 'content' | 'action' | 'citations' | 'webSources'>> {
  if (!endpoint) reject(503, 'CHAT_NOT_CONFIGURED', 'Kassandra is not configured yet.');
  // Leave time around the inference Worker's 160-second deadline to return its
  // result, then let the outer API persist it before the browser's 180 seconds.
  const timeout = AbortSignal.timeout(170_000);
  let response: Response;
  try {
    response = await fetch(new URL('/chat', endpoint), {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, content, context }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'manual',
    });
  } catch {
    return reject(503, 'CHAT_UNAVAILABLE', 'Kassandra could not finish. Please try again.');
  }
  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof result?.code === 'string' ? result.code : 'CHAT_UNAVAILABLE';
    const messages: Record<string, string> = {
      CHAT_RATE_LIMITED: 'Kassandra is busy. Please try again shortly.',
      OPENAI_QUOTA_EXCEEDED:
        'The OpenAI project has no available credit. Check its billing settings.',
      OPENAI_MODEL_UNAVAILABLE: 'The configured OpenAI model is unavailable to this project.',
      CHAT_NOT_CONFIGURED: 'Kassandra is not configured yet.',
    };
    reject(
      response.status === 429 ? 429 : 503,
      code,
      messages[code] ?? 'Kassandra could not finish. Please try again.',
    );
  }
  if (
    typeof result?.content !== 'string' ||
    !result.content.trim() ||
    result.content.length > 10000 ||
    (result.action !== undefined &&
      (!isChatAction(result.action) || result.action.status !== 'pending'))
  )
    reject(502, 'INVALID_CHAT_RESPONSE', 'Kassandra returned an incomplete answer. Please retry.');
  // Actions originate only from our validated MCP preparation tools, never model prose.
  return {
    content: result.content,
    ...(result.action ? { action: result.action as Message['action'] } : {}),
    ...messageSources(result, result.content),
  };
}
