const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Dữ liệu mẫu trong bộ nhớ
let items = [
  { id: 1, name: 'Kubernetes Cluster', owner: 'tungnv_b23dckh130' },
  { id: 2, name: 'ArgoCD GitOps', owner: 'tungnv_b23dckh130' }
];

// Bộ đếm Prometheus Metrics
let totalRequests = 0;
const statusCounts = { 200: 0, 201: 0, 403: 0, 404: 0, 409: 0 };

// Bộ đếm Rate Limit theo cửa sổ 1 phút (60,000 ms)
// Giới hạn: Tối đa 10 requests / phút -> Request thứ 11 trả về HTTP 409
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const clientRequests = new Map();

function checkRateLimit(clientKey) {
  const now = Date.now();
  const timestamps = clientRequests.get(clientKey) || [];
  // Chỉ giữ lại các request trong vòng 60 giây gần nhất
  const validTimestamps = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (validTimestamps.length >= RATE_LIMIT_MAX) {
    clientRequests.set(clientKey, validTimestamps);
    return false; // Vượt quá 10 req/phút
  }
  validTimestamps.push(now);
  clientRequests.set(clientKey, validTimestamps);
  return true;
}

// Hàm xác thực & lấy Role từ Header
// Hỗ trợ cả 3 chuẩn:
// 1. Basic Auth: curl -u admin:admin123 hoặc curl -u user:user123
// 2. Bearer Token: Authorization: Bearer admin-token | user-token
// 3. Header: X-Role: admin | user
function getRole(req) {
  const authHeader = (req.headers['authorization'] || '').trim();
  const roleHeader = (req.headers['x-role'] || '').trim().toLowerCase();

  if (authHeader.startsWith('Basic ')) {
    const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const [username, password] = credentials.split(':');
    if (username === 'admin' && (password === 'admin123' || password === 'admin')) return 'admin';
    if (username === 'user' && (password === 'user123' || password === 'user')) return 'user';
  }

  if (authHeader === 'Bearer admin-token' || roleHeader === 'admin') return 'admin';
  if (authHeader === 'Bearer user-token' || roleHeader === 'user') return 'user';
  return null;
}

// Hàm trả phản hồi & ghi Structured Log (phục vụ EFK Logging 1.5đ)
function sendResponse(req, res, statusCode, payload, contentType = 'application/json') {
  const parsedUrl = url.parse(req.url, true);
  const requestPath = parsedUrl.pathname;
  const httpMethod = req.method;

  totalRequests++;
  statusCounts[statusCode] = (statusCounts[statusCode] || 0) + 1;

  // Ghi log JSON ra stdout để Fluent Bit thu thập đẩy vào Elasticsearch
  const logEntry = {
    timestamp: new Date().toISOString(),
    service: 'api-service',
    http_method: httpMethod,
    request_path: requestPath,
    response_code: statusCode,
    role: getRole(req) || 'anonymous',
    client_ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
  };
  console.log(JSON.stringify(logEntry));

  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Role',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });

  if (contentType === 'application/json') {
    res.end(JSON.stringify(payload));
  } else {
    res.end(payload);
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Role',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    return res.end();
  }

  // 1. Healthcheck cho Kubernetes Probe (không tính rate limit)
  if (path === '/healthz') {
    return sendResponse(req, res, 200, { status: 'ok' });
  }

  // 2. Endpoint /metrics cho Prometheus (Monitoring 1.5đ - không tính rate limit)
  if (path === '/metrics') {
    const metricsText = [
      '# HELP app_http_requests_total Total number of HTTP requests',
      '# TYPE app_http_requests_total counter',
      `app_http_requests_total ${totalRequests}`,
      '# HELP app_http_responses_by_status_total HTTP responses by status code',
      '# TYPE app_http_responses_by_status_total counter',
      ...Object.entries(statusCounts).map(([code, count]) => `app_http_responses_by_status_total{code="${code}"} ${count}`),
      '# HELP process_uptime_seconds Process uptime in seconds',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${Math.floor(process.uptime())}`
    ].join('\n') + '\n';
    return sendResponse(req, res, 200, metricsText, 'text/plain; version=0.0.4');
  }

  // 3. Kiểm tra Rate Limit cho các API nghiệp vụ (>10 req/phút trả về 409)
  const clientKey = req.headers['x-forwarded-for'] || 'global-client';
  if (!checkRateLimit(clientKey)) {
    return sendResponse(req, res, 409, {
      error: 'Conflict - Rate limit exceeded (max 10 requests per minute)',
      code: 409
    });
  }

  // 4. Kiểm tra Authentication & RBAC (Security 1.0đ)
  const role = getRole(req);
  if (!role) {
    return sendResponse(req, res, 403, {
      error: 'Forbidden - Missing or invalid authentication token',
      code: 403
    });
  }

  // Endpoint /api/items
  if (path === '/api/items') {
    if (method === 'GET') {
      // Cả user và admin đều được phép GET (200)
      return sendResponse(req, res, 200, { role, data: items });
    }

    if (method === 'POST') {
      // Chỉ admin được phép POST, user bị từ chối (403)
      if (role !== 'admin') {
        return sendResponse(req, res, 403, {
          error: 'Forbidden - Role user cannot perform POST',
          code: 403
        });
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let newItem = { id: Date.now(), name: 'New Item', owner: 'admin' };
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.name) newItem.name = parsed.name;
        } catch (e) {}
        items.push(newItem);
        return sendResponse(req, res, 201, { message: 'Created', item: newItem });
      });
      return;
    }

    if (method === 'DELETE') {
      // Chỉ admin được phép DELETE, user bị từ chối (403)
      if (role !== 'admin') {
        return sendResponse(req, res, 403, {
          error: 'Forbidden - Role user cannot perform DELETE',
          code: 403
        });
      }
      const deleted = items.pop();
      return sendResponse(req, res, 200, { message: 'Deleted', deleted });
    }
  }

  return sendResponse(req, res, 404, { error: 'Not Found', path });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'api-service',
    message: `API Service listening on port ${PORT}`
  }));
});

