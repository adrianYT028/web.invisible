const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('SUPABASE_JWT_SECRET is not set. Auth gating will fail.');
}

const PUBLIC_PATHS = new Set([
  '/login',
  '/login/',
  '/login/index.html',
  '/login/reset',
  '/login/reset/',
  '/login/reset/index.html',
  '/login.html',
  '/favicon.ico'
]);

app.use(cookieParser());
app.use(express.static(path.join(__dirname), {
  index: false
}));

function isHtmlRequest(req) {
  const accept = req.headers.accept || '';
  return accept.includes('text/html');
}

function isPublicPath(reqPath) {
  if (PUBLIC_PATHS.has(reqPath)) return true;
  return false;
}

function verifyAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();
  if (!isHtmlRequest(req)) return next();

  const token = req.cookies.sb_access_token;
  if (!token || !JWT_SECRET) {
    return res.redirect('/login/');
  }

  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.redirect('/login/');
  }
}

app.use(verifyAuth);

app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login/', (req, res) => {
  return res.sendFile(path.join(__dirname, 'login', 'index.html'));
});

app.get('/login/reset/', (req, res) => {
  return res.sendFile(path.join(__dirname, 'login', 'reset', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
