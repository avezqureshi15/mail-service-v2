import { Router } from 'express';
import { z } from 'zod';
import {
  findByEmail, findById, verifyPassword, recordLogin, listUsers,
  createUser, setActive, setPassword, logAction,
} from '../db/repositories/users.js';
import { authLimiter, requireAuth, requireAdmin, validate } from '../middleware/index.js';

export const authRouter = Router();

const credentials = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// Express 4 does not forward a throw from an async handler to the error
// middleware on its own - it just becomes a silently dropped rejection, and
// with nothing watching for that, Node treats it as fatal and takes the
// whole process down. Every async handler below goes through try/catch and
// `next(error)` for exactly that reason.
authRouter.post('/login', authLimiter, validate(credentials), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await findByEmail(email);

    // One generic message whether the account is missing, wrong-password or
    // deactivated - anything more tells an attacker which emails are valid.
    const reject = () => res.status(401).json({ error: 'Invalid email or password' });

    if (!user || !user.is_active) {
      // Still spend the hashing time so a missing account is not detectably
      // faster than a wrong password.
      await verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      return reject();
    }

    if (!(await verifyPassword(password, user.password_hash))) return reject();

    // Rotate the session id on privilege change to block session fixation.
    req.session.regenerate(async (err) => {
      if (err) return res.status(500).json({ error: 'Could not start session' });
      try {
        req.session.userId = user.id;
        await recordLogin(user.id);
        await logAction({ userId: user.id, action: 'login' });
        res.json({ user: await findById(user.id) });
      } catch (error) {
        // Inside a callback, so a throw here would never reach the try/catch
        // around the handler - it has to be forwarded by hand.
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(() => {
    // Not awaited: the session is already gone, so the audit row must not
    // delay - or be able to fail - the response that clears the cookie.
    if (userId) logAction({ userId, action: 'logout' }).catch(() => {});
    res.clearCookie('msid');
    res.json({ ok: true });
  });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user });
});

// --- User administration ---------------------------------------------------

export const usersRouter = Router();

usersRouter.use(requireAuth, requireAdmin);

usersRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ users: await listUsers() });
  } catch (error) {
    next(error);
  }
});

const newUser = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).default(''),
  // Long enough to resist offline cracking; length beats composition rules.
  password: z.string().min(12, 'Password must be at least 12 characters'),
  role: z.enum(['admin', 'sender']).default('sender'),
});

usersRouter.post('/', validate(newUser), async (req, res, next) => {
  try {
    const { email, name, password, role } = req.body;
    if (await findByEmail(email)) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    const user = await createUser({ email, name, password, role });
    await logAction({ userId: req.user.id, action: 'user.create', entity: 'user', entityId: user.id, detail: { email, role } });
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

usersRouter.patch('/:id/active', validate(z.object({ isActive: z.boolean() })), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // Locking yourself out leaves nobody able to administer the system.
    if (id === req.user.id && !req.body.isActive) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    const user = await setActive(id, req.body.isActive);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAction({ userId: req.user.id, action: 'user.set_active', entity: 'user', entityId: id, detail: { isActive: req.body.isActive } });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

usersRouter.patch('/:id/password', validate(z.object({ password: z.string().min(12) })), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = await setPassword(id, req.body.password);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAction({ userId: req.user.id, action: 'user.reset_password', entity: 'user', entityId: id });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});
