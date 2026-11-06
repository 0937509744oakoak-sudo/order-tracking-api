import 'express-async-errors';
import express, { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { orders } from './orders';
import { AppError } from './errors';
import { logger } from './logger';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Capture the order number before request logging begins, even for nested routes.
app.use('/orders/:orderNo', (req: Request, _res: Response, next: NextFunction) => {
  req.headers['x-order-no'] = req.params.orderNo;
  next();
});
app.use(pinoHttp({ logger, customProps: req => ({ orderNo: req.header('X-Order-No') }) }));
app.get('/health', (_req,res) => res.json({ success: true, data: { status: 'ok' } }));
app.use('/orders', orders);

app.use((_req,res) => res.status(404).json({ success: false, code: 'ROUTE_NOT_FOUND', message: 'Route was not found' }));
const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const appError = error instanceof AppError ? error : undefined;
  const malformedBody = error instanceof SyntaxError && 'body' in error;
  const parserStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  const status = appError?.status ?? (malformedBody ? 400 : parserStatus ?? 500);
  const code = appError?.code ?? (malformedBody ? 'INVALID_JSON' : status === 413 ? 'REQUEST_TOO_LARGE' : status < 500 ? 'REQUEST_ERROR' : 'INTERNAL_SERVER_ERROR');
  const message = appError?.message ?? (malformedBody ? 'Request body contains invalid JSON' : status === 413 ? 'Request body is too large' : status < 500 ? 'Request could not be processed' : 'An unexpected error occurred');
  const orderNo = req.params.orderNo ?? req.header('X-Order-No');
  if (status >= 500) logger.error({ err: error, orderNo, path: req.path }, 'request failed');
  else logger.warn({ code, orderNo, path: req.path }, 'request rejected');
  if (!res.headersSent) res.status(status).json({ success: false, code, message });
};
app.use(errorHandler);
export default app;
