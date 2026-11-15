import type { Insight, Message } from './models';
import type { RoomOperationAction, RoomRateUpdateRequest } from './mutation.models';
import { messageSources } from './chat-sources';
import { isRateUpdateBatch, isRateUpdateRequest, type RateUpdateReviewItem } from './rate-batch';

interface ChatActionBase {
  readonly id: string;
  readonly status: 'pending' | 'applied' | 'cancelled';
  readonly summary: string;
}

/** A server-created proposal. Only the authenticated confirmation endpoint can apply it. */
export type ChatAction =
  | (ChatActionBase & {
      readonly kind: 'rate_batch_update';
      readonly details: { readonly updates: RateUpdateReviewItem[] };
    })
  | (ChatActionBase & {
      readonly kind: 'rate_update';
      readonly details: RoomRateUpdateRequest & {
        readonly hotelName: string;
        readonly roomTypeName: string;
      };
    })
  | (ChatActionBase & {
      readonly kind: 'room_action';
      readonly details: {
        readonly roomId: string;
        readonly hotelName: string;
        readonly roomNumber: string;
        readonly action: RoomOperationAction;
        readonly date: string;
      };
    });

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T12:00:00Z')) &&
  new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;

export function isChatAction(value: unknown): value is ChatAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (
    typeof action.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(action.id) ||
    !['pending', 'applied', 'cancelled'].includes(action.status as string) ||
    !text(action.summary, 400) ||
    !action.details ||
    typeof action.details !== 'object' ||
    Array.isArray(action.details)
  )
    return false;
  const details = action.details as Record<string, unknown>;
  if (action.kind === 'rate_batch_update') return isRateUpdateBatch(details.updates);
  if (!text(details.hotelName, 200)) return false;
  if (action.kind === 'room_action')
    return (
      text(details.roomId, 64) &&
      text(details.roomNumber, 64) &&
      date(details.date) &&
      ['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'].includes(
        details.action as string,
      )
    );
  if (action.kind !== 'rate_update') return false;
  return isRateUpdateRequest(details) && text(details.roomTypeName, 200);
}

/** Reuses the existing bounded JSON column, preserving pre-MCP direct Insight documents. */
type MessagePayload = Pick<Message, 'insight' | 'action' | 'citations' | 'webSources'>;
export function encodeMessagePayload(
  message: MessagePayload & { content?: string },
): string | null {
  const sources = messageSources(message as Record<string, unknown>, message.content);
  if (!message.insight && !message.action && !sources.citations && !sources.webSources) return null;
  return JSON.stringify({
    payloadVersion: 1,
    ...(message.insight ? { insight: message.insight } : {}),
    ...(message.action ? { action: message.action } : {}),
    ...sources,
  });
}

export function decodeMessagePayload(json: string | null, content?: string): MessagePayload {
  if (!json) return {};
  const payload = JSON.parse(json) as Record<string, unknown>;
  if (payload.payloadVersion !== 1) return { insight: payload as unknown as Insight };
  return {
    ...(payload.insight ? { insight: payload.insight as Insight } : {}),
    ...(isChatAction(payload.action) ? { action: payload.action } : {}),
    ...messageSources(payload, content),
  };
}
