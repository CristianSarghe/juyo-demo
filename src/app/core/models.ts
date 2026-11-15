import type { ReportingMonth } from './network.models';
import type {
  RateUpdateReviewItem,
  RoomOperationAction,
  RoomRateUpdateRequest,
} from './api/mutation.models';

export interface User {
  name: string;
  email: string;
}

export interface HotelProperty {
  id: string;
  name: string;
  location: string;
}

export interface Insight {
  title: string;
  summary: string;
  metrics: { label: string; value: string; change: string }[];
  chart?: { label: string; value: number; comparison: number }[];
  chartTitle?: string;
  chartUnit?: 'percent' | 'currency';
  chartSeries?: { value: string; comparison: string };
  reportingPeriod?: string;
  recommendation: string;
  sources: string[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  insight?: Insight;
  action?: ChatAction;
  sources?: string[];
  citations?: WebCitation[];
  webSources?: WebSource[];
  createdAt: string;
}

export interface WebSource {
  url: string;
  title: string;
}

export interface WebCitation extends WebSource {
  startIndex: number;
  endIndex: number;
}

export type ChatAction = {
  id: string;
  status: 'pending' | 'applied' | 'cancelled';
  summary: string;
} & (
  | {
      kind: 'rate_update';
      details: RoomRateUpdateRequest & { hotelName: string; roomTypeName: string };
    }
  | {
      kind: 'rate_batch_update';
      details: { readonly updates: readonly RateUpdateReviewItem[] };
    }
  | {
      kind: 'room_action';
      details: {
        roomId: string;
        hotelName: string;
        roomNumber: string;
        action: RoomOperationAction;
        date: string;
      };
    }
);

const actionRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const actionText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const actionId = (value: unknown): value is string =>
  actionText(value, 64) && value === value.trim();
const actionDate = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1
  )
    return false;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};
const actionAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0.01 &&
  value <= 10_000 &&
  Math.abs(value * 100 - Math.round(value * 100)) <= 0.000001;

function isRateActionDetails(value: unknown): value is Record<string, unknown> {
  return (
    actionRecord(value) &&
    actionId(value['hotelId']) &&
    actionId(value['roomTypeId']) &&
    actionText(value['hotelName'], 200) &&
    actionText(value['roomTypeName'], 200) &&
    actionDate(value['startDate']) &&
    actionDate(value['endDate']) &&
    value['startDate'] <= value['endDate'] &&
    actionAmount(value['nightlyRate']) &&
    (value['eventId'] == null || actionId(value['eventId'])) &&
    (value['reason'] === undefined ||
      (typeof value['reason'] === 'string' && value['reason'].length <= 240))
  );
}

/** Cancellation needs only an owned pending proposal ID, even when its review is unsupported. */
export function isPendingChatAction(value: unknown): value is { id: string; status: 'pending' } {
  return actionRecord(value) && actionId(value['id']) && value['status'] === 'pending';
}

/** The UI must show a complete supported review before enabling any Apply request. */
export function isReviewableChatAction(value: unknown): value is ChatAction {
  if (
    !actionRecord(value) ||
    !actionId(value['id']) ||
    !['pending', 'applied', 'cancelled'].includes(value['status'] as string) ||
    !actionText(value['summary'], 400) ||
    !actionRecord(value['details'])
  )
    return false;
  const details = value['details'];
  if (value['kind'] === 'rate_batch_update') {
    const updates = details['updates'];
    if (
      !Array.isArray(updates) ||
      updates.length < 1 ||
      updates.length > 20 ||
      !updates.every(
        (row) =>
          isRateActionDetails(row) &&
          actionAmount(row['currentMinRate']) &&
          actionAmount(row['currentMaxRate']) &&
          row['currentMinRate'] <= row['currentMaxRate'] &&
          typeof row['expectedRateVersion'] === 'string' &&
          /^[a-f0-9]{64}$/.test(row['expectedRateVersion']),
      )
    )
      return false;
    return updates.every((row, index) =>
      updates
        .slice(0, index)
        .every(
          (other) =>
            row.hotelId !== other.hotelId ||
            row.roomTypeId !== other.roomTypeId ||
            row.startDate > other.endDate ||
            row.endDate < other.startDate,
        ),
    );
  }
  if (value['kind'] === 'rate_update') return isRateActionDetails(details);
  if (value['kind'] !== 'room_action') return false;
  return (
    actionText(details['hotelName'], 200) &&
    actionId(details['roomId']) &&
    actionText(details['roomNumber'], 64) &&
    actionDate(details['date']) &&
    ['clean', 'dirty', 'reserve', 'out_of_service', 'available', 'reset'].includes(
      details['action'] as string,
    )
  );
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
  propertyId?: string;
  month?: ReportingMonth;
  roomDate?: string;
  dataVersion?: string;
}
