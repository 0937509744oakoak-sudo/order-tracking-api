# Order Tracking API

REST API สำหรับติดตามออเดอร์และรับแจ้งปัญหา ใช้ Node.js 20+, TypeScript, Express และ PostgreSQL 16 พร้อม worker/scheduler ในโปรเซสเดียวกับ API

## เริ่มต้น

ต้องติดตั้ง Docker Desktop หรือ Docker Engine ที่มี Docker Compose จากนั้นรันคำสั่งเดียวจากโฟลเดอร์นี้:

```sh
docker compose up --build
```

API จะเปิดที่ `http://localhost:3000`; ตรวจสุขภาพได้ที่ `GET /health` และตัวอย่างคำขออยู่ใน [examples.http](examples.http) ฐานข้อมูลเก็บข้อมูลใน named volume `postgres_data` การหยุดด้วย `docker compose down` จะคงข้อมูลไว้; `docker compose down -v` ลบข้อมูล volume ด้วย

การพัฒนาในเครื่อง: `cp .env.example .env`, แก้ `DATABASE_URL` เป็น `localhost`, เปิด PostgreSQL ด้วย `docker compose up -d db` แล้วใช้ `npm install`, `npm run dev` หากต้องการ build ใช้ `npm run build` และ `npm start`

> compose ใช้รหัสผ่านสำหรับเครื่องพัฒนาที่กำหนดไว้ในไฟล์ ห้ามใช้ค่าเหล่านี้ในระบบจริง ให้เปลี่ยน secret, จำกัดการเข้าถึงฐานข้อมูล และเพิ่ม authentication/authorization ตามตัวตนลูกค้าและเจ้าหน้าที่ก่อนเปิด API สู่อินเทอร์เน็ต

## โครงสร้างและข้อมูล

- `orders`: สถานะปัจจุบัน ยอดเงิน รายการสินค้า ข้อมูล lease/retry และ UID ลูกค้า
- `order_timelines`: append-only audit trail ของการสร้าง เปลี่ยนสถานะ แจ้งปัญหา webhook และการทำงานของ worker
- `idempotency_keys`: fingerprint ของ request, response ที่บันทึกไว้ และวันหมดอายุ
- `order_issues`: รายงานจากลูกค้า
- `webhook_events`: กัน provider ส่ง event ซ้ำ และตรวจจับ event ID ที่ถูกนำมาใช้กับ payload อื่น

Schema ถูกสร้างเมื่อ PostgreSQL เริ่มต้นฐานข้อมูลใหม่จาก `db/init.sql` หากปรับ schema หลังสร้าง volume แล้ว ให้ใช้ migration ของระบบ migration ที่เลือก หรือสร้าง volume ใหม่เฉพาะข้อมูลทดสอบ

สถานะหลักคือ `PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED`; สถานะขัดข้องคือ `DELAYED`, `FAILED`, `EXPIRED`, `REFUNDED` ทุกการเปลี่ยนสถานะผ่าน state machine และเขียน timeline ใน transaction เดียวกัน ส่วน webhook ที่มาสายหรือขอเปลี่ยนสถานะที่ไม่อนุญาตจะได้ `409 INVALID_STATUS_TRANSITION` และไม่แก้สถานะ

## API

ทุก response สำเร็จมี `success: true`; error ใช้รูปแบบเดียวกัน: `{ "success": false, "code": "...", "message": "..." }` เลขออเดอร์ต้องเป็น `ORD-` ตามด้วยอักษร/ตัวเลข 4–12 ตัว; รูปแบบผิดได้ 400 และไม่พบเลขที่รูปแบบถูกต้องได้ 404

| Method / path | รายละเอียด |
| --- | --- |
| `POST /orders` | สร้างออเดอร์ ต้องส่ง `Idempotency-Key`; body `{ "amount": 100, "items": [{"sku":"GAME-CREDIT","quantity":1}], "customerUid":"player-123" }` |
| `GET /orders/:orderNo` | อ่านรายละเอียดออเดอร์ |
| `GET /orders?tab=current&page=1&limit=20` | แบ่งหน้า เรียงใหม่ไปเก่า; `current` รวม pending/queued/in-progress/delayed และ `history` รวม completed/failed/expired/refunded |
| `GET /orders/:orderNo/timeline` | ประวัติสถานะและ event ตามเวลา |
| `POST /orders/:orderNo/report-issue` | body `{ "category":"DELAY", "description":"Order has not progressed" }`; บันทึก issue และ timeline |

มี endpoint เสริมเพื่อให้ workflow สมบูรณ์: `POST /orders/:orderNo/correct-uid` รับ `{ "customerUid":"new-id" }` สำหรับออเดอร์ FAILED/DELAYED แล้วส่งกลับ QUEUED; `POST /orders/webhooks/status` รับ `{ "eventId":"provider-event-1", "orderNo":"ORD-...", "status":"QUEUED" }` และจำลอง callback จากผู้ให้บริการ ทั้งสอง endpoint ยังต้องเพิ่มการยืนยันตัวตน/ลายเซ็น webhook ก่อนใช้จริง

ออเดอร์เริ่มเป็น `PENDING_PAYMENT`; webhook การชำระเงินที่ยืนยันแล้วเปลี่ยนเป็น `QUEUED` จึงเข้าสู่ fulfillment worker API ตัวอย่างนี้ไม่ได้เชื่อม payment gateway

## การจัดการ 5 เคส

1. **Bot ล่มหรือ timeout — lease, heartbeat และ exponential backoff**: worker ประทับ `locked_at` ตอน claim และ heartbeat ระหว่างเรียก supplier; worker ที่ตายจะถูกตรวจเมื่อ lease หมดอายุ (`LEASE_TIMEOUT_SECONDS`). งานถูกส่งเป็น `DELAYED` และลองใหม่ด้วยเวลารอ 10, 20 วินาที (สูตร `5 × 2^retry_count`), จำกัดสามครั้ง หลังครั้งที่สามไม่มี `next_retry_at` จึงต้องให้เจ้าหน้าที่แก้ UID/สั่งทำใหม่ การเปลี่ยนผลแต่ละครั้งบันทึก timeline
2. **Race condition — atomic claim**: การ claim ใช้ `SELECT ... FOR UPDATE SKIP LOCKED` แล้วเปลี่ยนสถานะเป็น `IN_PROGRESS` ภายใน transaction; หลาย replica จึงข้ามแถวที่ worker อื่นล็อกอยู่ การแก้สถานะ API และ scheduler ก็ล็อกออเดอร์ด้วย `FOR UPDATE`
3. **Webhook ซ้ำหรือมาช้า — event log และ state machine**: `webhook_events.event_id` เป็น primary key; event เดิมและ payload เดิมตอบสำเร็จโดยไม่ทำซ้ำ ส่วน event ID ที่ payload เปลี่ยนตอบ 409 ก่อนเปลี่ยนสถานะ การเปลี่ยนสถานะที่ย้อนกลับ/ผิดลำดับถูกตรวจด้วย state machine และ transaction
4. **เติมไม่สำเร็จหรือ UID ผิด — transient/permanent แยกกัน**: adapter คืน `transient` เพื่อเข้าคิว retry หรือ `permanent` เพื่อเปลี่ยนเป็น FAILED ทันที เจ้าหน้าที่/ช่องทางที่ยืนยันตัวลูกค้าแล้วใช้ `correct-uid` เพื่อแก้ UID, reset retry และ requeue; การเปลี่ยน UID ต้องมีสิทธิ์ตรวจสอบในระบบจริง
5. **ออเดอร์ค้าง — scheduler**: scheduler ตรวจ `PENDING_PAYMENT` เกิน `PAYMENT_TIMEOUT_MINUTES` แล้วปิดเป็น EXPIRED และแจ้งเตือน `QUEUED` ที่เกิน `QUEUED_SLA_MINUTES` ผ่าน structured log และ timeline เพียงครั้งเดียวต่อออเดอร์ ปรับค่าได้จาก environment

## Worker adapter และการนำไปใช้จริง

`src/worker.ts` มี adapter จำลองเพื่อให้โปรเจกต์รันทดสอบ flow ได้เอง โดยสำเร็จเป็นค่าเริ่มต้น; ถ้ามี `simulateError: "transient"` หรือ `simulateError: "invalid_uid"` ใน item จะจำลอง timeout/UID ผิด ให้แทนฟังก์ชัน `fulfill` ด้วย SDK ผู้ให้บริการจริง, กำหนด timeout ฝั่ง HTTP, ตรวจ signature webhook, เก็บ credentials ใน secret manager และทำ callback ให้ผูกกับ order/event ID การใช้งานจริงควรเพิ่ม authentication, authorization ตามเจ้าของออเดอร์, rate limiting, validation ราคาจาก catalog ฝั่ง server, metrics/alerting และ migration runner

Log เป็น JSON ผ่าน Pino; request log และ event log แนบ `orderNo` เมื่อเส้นทางมีเลขออเดอร์ หลีกเลี่ยงการใส่ข้อมูลส่วนบุคคลหรือ secret ในข้อความ log
