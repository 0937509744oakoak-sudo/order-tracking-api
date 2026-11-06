import { PoolClient } from 'pg';
import { config } from './config';
import { pool, query, transaction } from './db';
import { logger } from './logger';
import { assertTransition } from './state-machine';
import { changeStatus } from './orders';

type ClaimedOrder = { id: string; order_no: string; status: string; items: Array<Record<string, unknown>>; customer_uid: string | null; retry_count: number };
type FulfillmentResult = { kind: 'success' } | { kind: 'transient'; message: string } | { kind: 'permanent'; message: string };

// Replace with the real supplier/game fulfillment client. The demo adapter allows
// predictable local runs: include {"simulateError":"transient"|"invalid_uid"} in an item to exercise failures.
async function fulfill(order: ClaimedOrder): Promise<FulfillmentResult> {
  const mode = order.items.find(item => item.simulateError)?.simulateError;
  if (mode === 'transient') return { kind: 'transient', message: 'Simulated supplier timeout' };
  if (mode === 'invalid_uid') return { kind: 'permanent', message: 'Supplier rejected customer UID' };
  return { kind: 'success' };
}

async function recordRetry(client: PoolClient, order: ClaimedOrder, message: string) {
  const nextAttempt = order.retry_count + 1;
  const exhausted = nextAttempt >= 3;
  const delaySeconds = Math.min(300, 2 ** nextAttempt * 5);
  const to = 'DELAYED';
  assertTransition(order.status,to);
  await client.query(
    `UPDATE orders SET status=$2,retry_count=$3,locked_at=NULL,next_retry_at=$4,updated_at=now() WHERE id=$1`,
    [order.id,to,nextAttempt,exhausted ? null : new Date(Date.now() + delaySeconds * 1000)]);
  await client.query(
    `INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message,metadata) VALUES($1,$2,$3,'FULFILLMENT_RETRY',$4,$5)`,
    [order.id,order.status,to,message,JSON.stringify({ retryCount: nextAttempt, exhausted, delaySeconds: exhausted ? null : delaySeconds })]);
  logger.warn({ orderNo: order.order_no, retryCount: nextAttempt, exhausted, delaySeconds: exhausted ? null : delaySeconds }, 'fulfillment retry scheduled');
}

async function recoverExpiredLeases() {
  await transaction(async client => {
    // A stale worker lease means the process crashed or timed out. SKIP LOCKED lets
    // multiple API replicas recover leases without processing the same order.
    const stale = await client.query<ClaimedOrder>(
      `SELECT id,order_no,status,items,customer_uid,retry_count FROM orders
       WHERE status='IN_PROGRESS' AND locked_at < now() - ($1 || ' seconds')::interval
       ORDER BY locked_at FOR UPDATE SKIP LOCKED LIMIT 25`, [config.leaseTimeoutSeconds]);
    for (const order of stale.rows) await recordRetry(client,order,'Worker lease expired; retrying after timeout');
  });
}

async function expirePaymentOrders() {
  await transaction(async client => {
    const expired = await client.query<ClaimedOrder>(
      `SELECT id,order_no,status,items,customer_uid,retry_count FROM orders
       WHERE status='PENDING_PAYMENT' AND created_at < now() - ($1 || ' minutes')::interval
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100`, [config.paymentTimeoutMinutes]);
    for (const order of expired.rows) {
      await changeStatus(client,order,'EXPIRED','PAYMENT_EXPIRED',`Payment not received within ${config.paymentTimeoutMinutes} minutes`);
    }
  });
}

async function alertQueuedSla() {
  // Track each order only once using a unique timeline entry checked under lock.
  await transaction(async client => {
    const overdue = await client.query<ClaimedOrder>(
      `SELECT id,order_no,status,items,customer_uid,retry_count FROM orders
       WHERE status='QUEUED' AND updated_at < now() - ($1 || ' minutes')::interval
       ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 100`, [config.queuedSlaMinutes]);
    for (const order of overdue.rows) {
      const seen = await client.query(`SELECT 1 FROM order_timelines WHERE order_id=$1 AND event_type='QUEUED_SLA_ALERT' LIMIT 1`, [order.id]);
      if (!seen.rowCount) {
        await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message) VALUES($1,'QUEUED','QUEUED','QUEUED_SLA_ALERT',$2)`, [order.id,`Queued beyond ${config.queuedSlaMinutes} minute SLA`]);
        logger.warn({ orderNo: order.order_no, slaMinutes: config.queuedSlaMinutes }, 'queued order exceeded SLA');
      }
    }
  });
}

async function claimOrder(): Promise<ClaimedOrder | null> {
  return transaction(async client => {
    // Atomic claim: concurrent worker replicas skip rows already locked by another.
    const result = await client.query<ClaimedOrder>(
      `SELECT id,order_no,status,items,customer_uid,retry_count FROM orders
       WHERE (status='QUEUED' OR (status='DELAYED' AND next_retry_at IS NOT NULL AND next_retry_at <= now()))
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const order = result.rows[0];
    if (!order) return null;
    const from = order.status;
    assertTransition(from,'IN_PROGRESS');
    await client.query(`UPDATE orders SET status='IN_PROGRESS',locked_at=now(),next_retry_at=NULL,updated_at=now() WHERE id=$1`, [order.id]);
    await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message) VALUES($1,$2,'IN_PROGRESS','FULFILLMENT_CLAIMED','Worker acquired order lease')`, [order.id,from]);
    return { ...order, status: 'IN_PROGRESS' };
  });
}

async function processOrder(order: ClaimedOrder) {
  logger.info({ orderNo: order.order_no, retryCount: order.retry_count }, 'fulfillment started');
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    heartbeat = setInterval(() => {
      void query(`UPDATE orders SET locked_at=now() WHERE id=$1 AND status='IN_PROGRESS'`, [order.id])
        .catch(error => logger.error({ err: error, orderNo: order.order_no }, 'lease heartbeat failed'));
    }, Math.max(5000, Math.floor(config.leaseTimeoutSeconds * 1000 / 3)));
    const result = await fulfill(order);
    await transaction(async client => {
      const locked = await client.query(`SELECT id,order_no,status FROM orders WHERE id=$1 FOR UPDATE`, [order.id]);
      if (!locked.rowCount || locked.rows[0].status !== 'IN_PROGRESS') return;
      if (result.kind === 'success') {
        await changeStatus(client,locked.rows[0],'COMPLETED','FULFILLMENT_COMPLETED','Supplier fulfilled order');
        await client.query('UPDATE orders SET locked_at=NULL,next_retry_at=NULL WHERE id=$1',[order.id]);
      } else if (result.kind === 'permanent') {
        await changeStatus(client,locked.rows[0],'FAILED','FULFILLMENT_PERMANENT_FAILURE',result.message);
        await client.query('UPDATE orders SET locked_at=NULL,next_retry_at=NULL WHERE id=$1',[order.id]);
        logger.error({ orderNo: order.order_no, reason: result.message }, 'permanent fulfillment failure; customer may correct UID');
      } else await recordRetry(client,{ ...order, status: locked.rows[0].status },result.message);
    });
  } catch (error) {
    logger.error({ err: error, orderNo: order.order_no }, 'fulfillment worker failed');
    await transaction(async client => {
      const locked = await client.query(`SELECT id,order_no,status,items,customer_uid,retry_count FROM orders WHERE id=$1 FOR UPDATE`,[order.id]);
      if (locked.rowCount && locked.rows[0].status === 'IN_PROGRESS') await recordRetry(client,locked.rows[0],`Worker error: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  } finally { if (heartbeat) clearInterval(heartbeat); }
}

let running = false;
export function startWorker() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await recoverExpiredLeases();
      await expirePaymentOrders();
      await alertQueuedSla();
      const order = await claimOrder();
      if (order) await processOrder(order);
      await query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    } catch (error) { logger.error({ err: error }, 'scheduler tick failed'); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, config.workerIntervalMs);
  void tick();
  logger.info({ intervalMs: config.workerIntervalMs }, 'order scheduler started');
  return () => clearInterval(timer);
}

export async function closeWorkerResources() { await pool.end(); }
