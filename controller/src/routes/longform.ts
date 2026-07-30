// Admin diagnostics/control for the listener-triggered spoken programme.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  endLongformEpisode,
  longformRuntimeStatus,
  refreshLongformRuntime,
} from '../broadcast/longform/runtime.js';

export const router = express.Router();

router.get('/longform', requireAdmin, (_req, res) => {
  res.json(longformRuntimeStatus());
});

router.post('/longform/refresh', requireAdmin, async (_req, res) => {
  try {
    await refreshLongformRuntime();
    res.json(longformRuntimeStatus());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/longform/stop', requireAdmin, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 240)
      : 'operator-stopped';
    await endLongformEpisode(reason);
    res.json(longformRuntimeStatus());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

