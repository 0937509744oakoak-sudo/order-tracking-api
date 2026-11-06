import { AppError } from './errors';

export const statuses = ['PENDING_PAYMENT','QUEUED','IN_PROGRESS','COMPLETED','DELAYED','FAILED','EXPIRED','REFUNDED'] as const;
export type OrderStatus = typeof statuses[number];
const transitions: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['QUEUED','EXPIRED','REFUNDED'],
  QUEUED: ['IN_PROGRESS','DELAYED','FAILED','EXPIRED','REFUNDED'],
  IN_PROGRESS: ['COMPLETED','DELAYED','FAILED','REFUNDED'],
  DELAYED: ['QUEUED','IN_PROGRESS','FAILED','REFUNDED'],
  FAILED: ['QUEUED','REFUNDED'],
  COMPLETED: ['REFUNDED'], EXPIRED: ['REFUNDED'], REFUNDED: [],
};
export function assertTransition(from: string, to: string): asserts to is OrderStatus {
  if (!statuses.includes(from as OrderStatus) || !transitions[from as OrderStatus].includes(to as OrderStatus)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `Cannot change order from ${from} to ${to}`);
  }
}
export function isCurrent(status: string) { return ['PENDING_PAYMENT','QUEUED','IN_PROGRESS','DELAYED'].includes(status); }
