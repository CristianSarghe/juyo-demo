import type { ReportingMonth } from './network.models';
import type { ChatAction } from './chat.models';
export type { ChatAction } from './chat.models';

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
