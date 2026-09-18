const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');
require('dotenv').config();

const HMS_ACCESS_KEY = process.env.HMS_ACCESS_KEY;
const HMS_SECRET = process.env.HMS_SECRET;

/**
 * POST /api/hms/token
 * Generate a 100ms auth token for a user to join a room.
 *
 * Body: { roomId: string, role?: string }
 *
 * The role in the 100ms token maps to the 100ms template roles:
 * - Teachers get "host" role (can publish audio/video, share screen, manage room)
 * - Students get "guest" role (can publish audio/video)
 */
router.post('/token', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.body;

    if (!roomId) {
      return res.status(400).json({ error: 'roomId is required' });
    }

    // Map application roles to 100ms template roles
    const hmsRole = req.user.role === 'teacher' ? 'host' : 'guest';

    // Generate auth token
    const payload = {
      access_key: HMS_ACCESS_KEY,
      room_id: roomId,
      user_id: req.user.uid,
      role: hmsRole,
      type: 'app',
      version: 2,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
    };

    const token = jwt.sign(payload, HMS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '24h',
      jwtid: uuidv4(),
    });

    res.json({ token, role: hmsRole });
  } catch (error) {
    console.error('Generate HMS token error:', error);
    res.status(500).json({ error: 'Failed to generate video token' });
  }
});

module.exports = router;
