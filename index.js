require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust the first proxy (needed behind load balancers / PaaS for correct IPs)
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS — restrict to an explicit allowlist of origins.
// Requests with no Origin header (React Native apps, curl, server-to-server)
// are always allowed; browser cross-origin requests must be listed in CORS_ORIGINS.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const err = new Error('Not allowed by CORS');
      err.status = 403;
      return callback(err);
    },
  })
);

// Body parsing with a size limit to prevent oversized-payload abuse
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Health check (kept unthrottled for platform liveness probes)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rate limiting — strict on the auth endpoints to slow brute-force / credential stuffing
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// General API rate limit (looser) to protect the rest of the endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api', apiLimiter);

// Routes
const authRoutes = require('./routes/auth');
const classRoutes = require('./routes/classes');
const hmsRoutes = require('./routes/hms');
const messageRoutes = require('./routes/messages');

app.use('/api/auth', authRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/hms', hmsRoutes);
app.use('/api/messages', messageRoutes);

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('Unhandled error:', err);
  }
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
  });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Live Seminar Server running on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
});

// Graceful shutdown — close the HTTP server on termination signals so
// in-flight requests can finish (PaaS platforms send SIGTERM on redeploy).
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    console.log('HTTP server closed. Bye.');
    process.exit(0);
  });

  // Force-exit if connections do not drain in time
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
