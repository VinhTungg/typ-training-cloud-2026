const express = require('express');
const axios = require('axios');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 80;
const BACKEND_URL = process.env.BACKEND_URL || 'http://backend-service:5000';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Frontend metadata endpoint
app.get('/api/frontend-status', (req, res) => {
  res.json({
    podName: os.hostname(),
    platform: os.platform(),
    backendUrl: BACKEND_URL,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Proxy all /api/* requests to Backend service (Reverse Proxy / BFF pattern)
app.all('/api/*', async (req, res) => {
  const targetUrl = `${BACKEND_URL}${req.originalUrl}`;
  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(502).json({
        error: 'Bad Gateway - Cannot reach Backend service',
        backendUrl: targetUrl,
        details: error.message,
      });
    }
  }
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Frontend Web Server listening on port ${PORT}`);
  console.log(`Forwarding API requests to: ${BACKEND_URL}`);
});

