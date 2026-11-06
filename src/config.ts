export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://orders:orders_dev_password@localhost:5432/orders',
  paymentTimeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES ?? 30),
  queuedSlaMinutes: Number(process.env.QUEUED_SLA_MINUTES ?? 10),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 5000),
  leaseTimeoutSeconds: Number(process.env.LEASE_TIMEOUT_SECONDS ?? 60),
  idempotencyRetentionDays: Number(process.env.IDEMPOTENCY_RETENTION_DAYS ?? 7),
};
