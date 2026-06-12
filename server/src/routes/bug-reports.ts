import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getAuthDb } from '../auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = Router();

const VALID_CATEGORIES = [
  'import',
  'wykres',
  'portfel',
  'transakcje',
  'dywidendy',
  'waluty',
  'inne',
];

// POST /api/bug-reports — submit a bug report
router.post(
  '/',
  asyncHandler((req, res) => {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

    const { category, description } = req.body;

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    if (!description?.trim() || description.trim().length < 5) {
      return res.status(400).json({ error: 'Description must be at least 5 characters' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 characters)' });
    }

    const db = getAuthDb();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO bug_reports (id, userId, userEmail, category, description, userAgent, url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.userId,
      req.userEmail || null,
      category,
      description.trim(),
      req.headers['user-agent'] || null,
      req.headers['referer'] || null,
    );

    res.json({ success: true, id });
  }),
);

// GET /api/bug-reports — list all reports (admin only — first registered user)
router.get(
  '/',
  requireAdmin,
  asyncHandler((req, res) => {
    const db = getAuthDb();
    const reports = db.prepare('SELECT * FROM bug_reports ORDER BY createdAt DESC LIMIT 100').all();
    res.json(reports);
  }),
);

export default router;
