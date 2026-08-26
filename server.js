'use strict';

const path = require('path');
const express = require('express');

const { createStore } = require('./src/config/store');
const buildApiRouter = require('./src/routes/api');

const PORT = process.env.PORT || 3000;

const app = express();
const store = createStore();

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/', buildApiRouter(store));

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.listen(PORT, () => {
  console.log('🚀 RateShield — открытое демо rate limiter\'а');
  console.log(`   http://localhost:${PORT}`);
  console.log('   Алгоритмы: /fixed, /sliding, /token');
  console.log('   Статус:    /status');
  console.log('   Аналитика: /api/stats');
});

module.exports = app;
