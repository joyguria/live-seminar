const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

// Fail fast: never boot with a missing or insecure default secret.
if (!JWT_SECRET || JWT_SECRET.trim() === '') {
  throw new Error(
    'FATAL: JWT_SECRET environment variable is not set. Refusing to start. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
  );
}

if (JWT_SECRET.length < 32) {
  throw new Error(
    'FATAL: JWT_SECRET is too short (must be at least 32 characters). Refusing to start.'
  );
}

/**
 * Middleware to verify JWT token from Authorization header.
 * Attaches decoded user info to req.user.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Please log in.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token.' });
  }
}

/**
 * Middleware to require a specific role.
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Access denied. ${role} role required.` });
    }
    next();
  };
}

/**
 * Generate a JWT for a user.
 */
function generateToken(user) {
  return jwt.sign(
    {
      uid: user.uid,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

module.exports = { authMiddleware, requireRole, generateToken };
