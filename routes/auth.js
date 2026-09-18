const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { authMiddleware, generateToken } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const BCRYPT_SALT_ROUNDS = 12;

/**
 * Hash a password with bcrypt (salted, adaptive cost).
 */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

/**
 * Legacy unsalted SHA-256 hash. Kept ONLY to migrate existing users to bcrypt.
 * Do not use for new accounts.
 */
function hashPasswordLegacy(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Detect a legacy SHA-256 hash (64 hex chars) so we can migrate it on next login.
 */
function isLegacyHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Verify a plaintext password against the stored hash. If the stored hash is a
 * legacy SHA-256 digest and the password matches, transparently re-hash it with
 * bcrypt and persist the upgrade (migration path for existing users).
 *
 * Returns true if the password is valid.
 */
async function verifyAndMigratePassword(userDoc, password) {
  const storedHash = userDoc.data().password;

  if (isLegacyHash(storedHash)) {
    const matches = storedHash === hashPasswordLegacy(password);
    if (matches) {
      const upgradedHash = await hashPassword(password);
      await userDoc.ref.update({ password: upgradedHash });
      console.log(`Migrated legacy password hash to bcrypt for user ${userDoc.data().uid}`);
    }
    return matches;
  }

  return bcrypt.compare(password, storedHash);
}

/**
 * POST /api/auth/register
 * Register a new user (student or teacher)
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Validate input
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'All fields are required: email, password, name, role' });
    }

    if (!['student', 'teacher'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "student" or "teacher"' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existingUser = await db.collection('users').where('email', '==', email).get();
    if (!existingUser.empty) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Create user document in Firestore
    const userRef = db.collection('users').doc();
    const userData = {
      uid: userRef.id,
      email: email.toLowerCase().trim(),
      name: name.trim(),
      role,
      password: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };

    await userRef.set(userData);

    // Generate JWT
    const token = generateToken(userData);

    // Return user (without password) and token
    const { password: _, ...userWithoutPassword } = userData;
    res.status(201).json({
      message: 'Registration successful',
      user: userWithoutPassword,
      token,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user by email
    const usersSnapshot = await db
      .collection('users')
      .where('email', '==', email.toLowerCase().trim())
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const userDoc = usersSnapshot.docs[0];
    const userData = userDoc.data();

    // Verify password (and transparently migrate legacy SHA-256 hashes to bcrypt)
    const passwordValid = await verifyAndMigratePassword(userDoc, password);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT
    const token = generateToken(userData);

    // Return user (without password) and token
    const { password: _, ...userWithoutPassword } = userData;
    res.json({
      message: 'Login successful',
      user: userWithoutPassword,
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

/**
 * GET /api/auth/me
 * Get current user profile from token
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Find user in Firestore by uid
    const usersSnapshot = await db
      .collection('users')
      .where('uid', '==', req.user.uid)
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = usersSnapshot.docs[0].data();
    const { password: _, ...userWithoutPassword } = userData;

    res.json({ user: userWithoutPassword });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

module.exports = router;
