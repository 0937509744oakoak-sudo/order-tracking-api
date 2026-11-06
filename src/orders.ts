import { createHash, randomBytes } from 'node:crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { query, transaction } from './db';
import { AppError } from './errors';
import { logger } from './logger';
import { assertTransition, isCurrent, OrderStatus } from './state-machine';

export const orders = Router();
const createSchema = z.object({ amount: z.number().nonnegative(), items: z.array(z.record(z.unknown())).min(1), customerUid: z.string().trim().min(1).max(120).optional() });
const orderNoPattern = /^ORD-[A-Z0-9]{4,12}$/;
function validateOrderNo(orderNo: string) { if (!orderNoPattern.test(orderNo)) throw new AppError(400, 'INVALID_ORDER_NO', 'orderNo must match ORD-xxxx format'); }
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function newOrderNo() { return `ORD-${randomBytes(5).toString('hex').toUpperCase()}`; }

orders.post('/', async (req, res) => {
  const input = createSchema.safeParse(req.body);
  if (!input.success) throw new AppError(400, 'VALIDATION_ERROR', input.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const key = req.header('Idempotency-Key');
  if (!key || key.length > 255) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header (max 255 characters)');
  const requestHash = hash(input.data);
  const result = await transaction(async client => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys(key, request_hash, expires_at) VALUES ($1,$2, now() + ($3::text || ' days')::interval)
       ON CONFLICT (key) DO NOTHING RETURNING key`, [key, requestHash, process.env.IDEMPOTENCY_RETENTION_DAYS ?? 7]);
    if (!inserted.rowCount) {
      const existing = await client.query('SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE key=$1 FOR UPDATE', [key]);
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      if (row.response_body) return { status: row.response_status ?? 201, body: row.response_body, replay: true };
      throw new AppError(409, 'REQUEST_IN_PROGRESS', 'An identical request is still being processed');
    }
    const orderNo = newOrderNo();
    const created = await client.query(
      `INSERT INTO orders(order_no,status,amount,items,idempotency_key,customer_uid) VALUES($1,'PENDING_PAYMENT',$2,$3,$4,$5) RETURNING *`,
      [orderNo, input.data.amount, JSON.stringify(input.data.items), key, input.data.customerUid ?? null]);
    const order = created.rows[0];
    await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message) VALUES($1,NULL,'PENDING_PAYMENT','ORDER_CREATED','Order created')`, [order.id]);
    const body = { success: true, data: order };
    await client.query('UPDATE idempotency_keys SET order_id=$2,response_status=201,response_body=$3 WHERE key=$1', [key, order.id, JSON.stringify(body)]);
    return { status: 201, body, replay: false };
  });
  logger.info({ orderNo: result.body.data.order_no, idempotencyReplay: result.replay }, 'order created');
  res.status(result.status).json(result.body);
});

orders.get('/', async (req, res) => {
  const tab = z.enum(['current','history']).safeParse(req.query.tab ?? 'current');
  const page = z.coerce.number().int().min(1).max(100000).safeParse(req.query.page ?? 1);
  const pageSize = z.coerce.number().int().min(1).max(100).safeParse(req.query.limit ?? 20);
  if (!tab.success || !page.success || !pageSize.success) throw new AppError(400, 'VALIDATION_ERROR', 'tab must be current|history; page >= 1 and limit 1..100');
  const condition = tab.data === 'current' ? "status = ANY(ARRAY['PENDING_PAYMENT','QUEUED','IN_PROGRESS','DELAYED'])" : "status = ANY(ARRAY['COMPLETED','FAILED','EXPIRED','REFUNDED'])";
  const offset = (page.data - 1) * pageSize.data;
  const [rows, count] = await Promise.all([
    query(`SELECT order_no,status,amount,items,created_at,updated_at FROM orders WHERE ${condition} ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`, [pageSize.data, offset]),
    query(`SELECT count(*)::int AS total FROM orders WHERE ${condition}`),
  ]);
  res.json({ success: true, data: rows.rows, pagination: { page: page.data, limit: pageSize.data, total: count.rows[0].total, totalPages: Math.ceil(count.rows[0].total / pageSize.data) } });
});

orders.get('/:orderNo/timeline', async (req, res) => {
  validateOrderNo(req.params.orderNo);
  const result = await query(`SELECT t.event_type,t.from_status,t.to_status,t.message,t.metadata,t.created_at FROM order_timelines t JOIN orders o ON o.id=t.order_id WHERE o.order_no=$1 ORDER BY t.created_at ASC,t.id ASC`, [req.params.orderNo]);
  if (!result.rowCount) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found');
  res.json({ success: true, data: result.rows });
});

orders.get('/:orderNo', async (req, res) => {
  validateOrderNo(req.params.orderNo);
  const result = await query('SELECT order_no,status,amount,items,customer_uid,retry_count,created_at,updated_at FROM orders WHERE order_no=$1', [req.params.orderNo]);
  if (!result.rowCount) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found');
  res.json({ success: true, data: result.rows[0] });
});

orders.post('/:orderNo/report-issue', async (req, res) => {
  validateOrderNo(req.params.orderNo);
  const input = z.object({ category: z.enum(['PAYMENT','DELAY','FULFILLMENT','WRONG_UID','OTHER']), description: z.string().trim().min(5).max(2000) }).safeParse(req.body);
  if (!input.success) throw new AppError(400, 'VALIDATION_ERROR', input.error.issues.map(i => i.message).join('; '));
  const result = await transaction(async client => {
    const order = await client.query('SELECT id,order_no,status FROM orders WHERE order_no=$1 FOR UPDATE', [req.params.orderNo]);
    if (!order.rowCount) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    const issue = await client.query('INSERT INTO order_issues(order_id,category,description) VALUES($1,$2,$3) RETURNING id,category,description,status,created_at', [order.rows[0].id,input.data.category,input.data.description]);
    await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message,metadata) VALUES($1,$2,$2,'ISSUE_REPORTED',$3,$4)`, [order.rows[0].id,order.rows[0].status,input.data.description,JSON.stringify({ issueId: issue.rows[0].id, category: input.data.category })]);
    return { issue: issue.rows[0], orderNo: order.rows[0].order_no };
  });
  logger.warn({ orderNo: result.orderNo, issueId: result.issue.id, category: input.data.category }, 'customer reported order issue');
  res.status(201).json({ success: true, data: result.issue });
});

// Support correction after an invalid UID; correction requeues a failed/delayed fulfillment.
orders.post('/:orderNo/correct-uid', async (req, res) => {
  validateOrderNo(req.params.orderNo);
  const input = z.object({ customerUid: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!input.success) throw new AppError(400, 'VALIDATION_ERROR', 'customerUid is required');
  const changed = await transaction(async client => {
    const found = await client.query('SELECT * FROM orders WHERE order_no=$1 FOR UPDATE', [req.params.orderNo]);
    if (!found.rowCount) throw new AppError(404,'ORDER_NOT_FOUND','Order was not found');
    const order = found.rows[0];
    if (!['FAILED','DELAYED'].includes(order.status)) throw new AppError(409,'ORDER_NOT_CORRECTABLE','Only FAILED or DELAYED orders can have UID corrected');
    assertTransition(order.status,'QUEUED');
    const updated = await client.query(`UPDATE orders SET customer_uid=$2,status='QUEUED',retry_count=0,next_retry_at=NULL,locked_at=NULL,updated_at=now() WHERE id=$1 RETURNING order_no,status`, [order.id,input.data.customerUid]);
    await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message) VALUES($1,$2,'QUEUED','UID_CORRECTED','Customer corrected UID; fulfillment requeued')`, [order.id,order.status]);
    return updated.rows[0];
  });
  logger.info({ orderNo: changed.order_no }, 'customer UID corrected');
  res.json({ success: true, data: changed });
});

// Optional provider webhook endpoint demonstrates duplicate and out-of-order event handling.
orders.post('/webhooks/status', async (req, res) => {
  const input = z.object({ eventId: z.string().min(1).max(255), orderNo: z.string(), status: z.enum(['QUEUED','IN_PROGRESS','COMPLETED','DELAYED','FAILED','REFUNDED']) }).safeParse(req.body);
  if (!input.success) throw new AppError(400,'VALIDATION_ERROR','eventId, orderNo and a supported status are required');
  validateOrderNo(input.data.orderNo);
  const payloadHash = hash(input.data);
  const outcome = await transaction(async client => {
    const orderResult = await client.query('SELECT * FROM orders WHERE order_no=$1 FOR UPDATE', [input.data.orderNo]);
    if (!orderResult.rowCount) throw new AppError(404,'ORDER_NOT_FOUND','Order was not found');
    const order = orderResult.rows[0];
    const inserted = await client.query(`INSERT INTO webhook_events(event_id,order_no,event_type,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, [input.data.eventId,input.data.orderNo,input.data.status,payloadHash]);
    if (!inserted.rowCount) {
      const previous = await client.query('SELECT payload_hash FROM webhook_events WHERE event_id=$1', [input.data.eventId]);
      if (previous.rows[0].payload_hash !== payloadHash) throw new AppError(409,'WEBHOOK_EVENT_ID_REUSED','Webhook event ID was reused with a different payload');
      return { duplicate: true, orderNo: order.order_no, status: order.status };
    }
    if (order.status === input.data.status) return { duplicate: false, ignored: true, orderNo: order.order_no, status: order.status };
    assertTransition(order.status,input.data.status);
    await client.query('UPDATE orders SET status=$2,locked_at=NULL,updated_at=now() WHERE id=$1', [order.id,input.data.status]);
    await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message,metadata) VALUES($1,$2,$3,'PROVIDER_WEBHOOK','Provider status event',$4)`, [order.id,order.status,input.data.status,JSON.stringify({eventId:input.data.eventId})]);
    return { duplicate: false, orderNo: order.order_no, status: input.data.status };
  });
  logger.info({ ...outcome, orderNo: outcome.orderNo }, 'provider webhook processed');
  res.json({ success: true, data: outcome });
});

export async function changeStatus(client: import('pg').PoolClient, order: { id: string; order_no: string; status: string }, to: OrderStatus, event: string, message: string, metadata: object = {}) {
  assertTransition(order.status,to);
  await client.query('UPDATE orders SET status=$2,updated_at=now() WHERE id=$1', [order.id,to]);
  await client.query(`INSERT INTO order_timelines(order_id,from_status,to_status,event_type,message,metadata) VALUES($1,$2,$3,$4,$5,$6)`, [order.id,order.status,to,event,message,JSON.stringify(metadata)]);
  logger.info({ orderNo: order.order_no, from: order.status, to, event }, 'order status changed');
}
