// server.js — entry point. Run with `npm start`.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { initSchema } = require('./db');
const authRoutes = require('./routes/auth');
const progressRoutes = require('./routes/progress');
const coachRoutes = require('./routes/coach');
const certificateRoutes = require('./routes/certificate');
const newsRoutes = require('./routes/news');

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
  })
);
app.use(express.json({ limit: '100kb' }));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
const coachLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many AI review requests. Please wait a few minutes.' } });

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/coach', coachLimiter, coachRoutes);
app.use('/api/certificate', certificateRoutes);
app.use('/api/news', newsRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 4000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`WELEZA Academy backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to set up the database. Check DATABASE_URL in .env.', err);
    process.exit(1);
  });
