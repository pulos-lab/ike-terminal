import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler to catch errors and return a consistent 500 response.
 * Eliminates repetitive try/catch blocks in route files.
 */
export function asyncHandler(
  fn: (req: Request<any, any, any, any>, res: Response, next: NextFunction) => Promise<any> | any,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      console.error(`${req.method} ${req.path} error:`, error);
      // Jeśli handler zdążył już wysłać nagłówki, res.status() by rzucił —
      // delegujemy do domyślnego mechanizmu Express.
      if (res.headersSent) {
        return next(error);
      }
      // W produkcji nie ujawniamy wewnętrznych komunikatów błędów
      // (spójnie z globalnym handlerem w index.ts).
      const message =
        process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : error.message || 'Internal server error';
      res.status(500).json({ error: message });
    });
  };
}
