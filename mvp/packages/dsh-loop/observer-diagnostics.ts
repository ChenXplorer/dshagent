import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session/types';

interface ObserverDiagnostic {
  requestId: string;
  turn: number;
  step: number;
  errorType: string;
  category: string;
  transportCode?: string;
  httpStatus?: number;
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'multica/observer-error': ObserverDiagnostic; }
}
declare module '@deepseek-ai/dsh-session' {
  interface Session {
    appendInformational(type: 'multica/observer-error', data: ObserverDiagnostic): SessionEvent<'multica/observer-error'>;
  }
}

const errorTypes = new Set(['Error', 'TypeError', 'TaskPendingError', 'MulticaApiError', 'AxiosError', 'TimeoutError', 'AbortError']);
const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED',
  'ERR_NETWORK', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const pendingCategories = new Map([
  ['Task observation deadline elapsed; execution/cancellation is not declared complete', 'observation-deadline'],
  ['Official task transcript has a sequence gap; synchronization position was not advanced', 'transcript-gap'],
  ['Transcript cursor changed concurrently; replay before continuing', 'cursor-conflict'],
  ['Task settlement raced another observer', 'settlement-conflict'],
  ['Unknown official task state; retained raw event and awaiting reconciliation', 'unknown-task-state'],
  ['Cancellation outcome is unconfirmed; its persisted intent will reconcile before a safe cancellation retry', 'cancellation-unconfirmed'],
]);

/** Allowlisted metadata only: never persist arbitrary errors, HTTP bodies, URLs or stacks. */
export function appendObserverDiagnostic(session: Session, error: unknown, identity: Pick<ObserverDiagnostic, 'requestId' | 'turn' | 'step'>): void {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const errorType = typeof record.name === 'string' && errorTypes.has(record.name) ? record.name : 'UnknownError';
  const response = record.response && typeof record.response === 'object' ? record.response as Record<string, unknown> : {};
  const status = record.status ?? response.status;
  const cause = record.cause && typeof record.cause === 'object' ? record.cause as Record<string, unknown> : {};
  const code = record.code ?? cause.code;
  const transportCode = typeof code === 'string' && transportCodes.has(code) ? code : undefined;
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
  const category = typeof record.message === 'string' && pendingCategories.get(record.message)
    || (transportCode ? 'transport' : httpStatus ? 'http' : errorType === 'TaskPendingError' ? 'pending-unclassified' : 'observer-unclassified');
  session.appendInformational('multica/observer-error', { ...identity, errorType, category,
    ...(transportCode ? { transportCode } : {}), ...(httpStatus ? { httpStatus } : {}) });
}
