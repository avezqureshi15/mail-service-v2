import rateLimit from 'express-rate-limit';
import { findById } from '../db/repositories/users.js';

/**
 * Loads the session user on every request and rejects anyone whose account
 * has since been deactivated - so revoking access takes effect on the next
 * request rather than when their session happens to expire.
 */
export async function loadUser(req, _res, next) {
  req.user = null;
  try {
    if (req.session?.userId) {
      const user = await findById(req.session.userId);
      if (user && user.is_active) {
        req.user = user;
      } else {
        req.session.destroy(() => {});
      }
    }
    next();
  } catch (error) {
    // A database hiccup must not be mistaken for a valid anonymous request:
    // every protected route would answer 401 and the UI would sign the rep
    // out mid-campaign. Report it as the server fault it is.
    next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

/**
 * Validates body/query against a zod schema and replaces it with the parsed
 * result, so handlers only ever see known-shaped data.
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    // req.query and req.params are getters in Express 5, so the parsed data
    // goes on a separate property rather than being assigned back. Handlers
    // read req.validatedQuery / req.validatedParams.
    if (source === 'query') req.validatedQuery = result.data;
    else if (source === 'params') req.validatedParams = result.data;
    else req[source] = result.data;
    next();
  };
}

const limiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

// Brute-force protection on the only password-accepting endpoint.
export const authLimiter = limiter(15 * 60 * 1000, 10, 'Too many login attempts. Try again in 15 minutes.');

// Public and unauthenticated by necessity, so they get their own ceilings.
export const unsubscribeLimiter = limiter(60 * 1000, 30, 'Too many requests.');
export const trackingLimiter = limiter(60 * 1000, 240, 'Too many requests.');
export const apiLimiter = limiter(60 * 1000, 300, 'Too many requests.');

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err, _req, res, _next) {
  // A route that set err.status wrote that message deliberately and meant it
  // to be read - "Test send failed: Username and Password not accepted" is
  // the whole answer. Only errors that reached here unlabelled are unexpected
  // and might leak internals, so only those are replaced.
  const deliberate = Number.isInteger(err.status);
  const status = deliberate ? err.status : 500;

  if (!deliberate) console.error('[error]', err);

  res.status(status).json({
    error: deliberate ? err.message : 'Internal server error',
    // Never leak a stack trace to the client in production.
    ...(!deliberate && process.env.NODE_ENV !== 'production' ? { detail: err.message } : {}),
  });
}
