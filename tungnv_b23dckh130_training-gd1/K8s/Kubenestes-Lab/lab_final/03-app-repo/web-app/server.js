const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;
const APP_VERSION = process.env.APP_VERSION || 'v1.0.1';

let webRequests = 0;

function renderHtml(version) {
  const isUpdated = version !== 'v1.0.0';
  const badgeBg = isUpdated ? '#dcfce7' : '#dbeafe';
  const badgeColor = isUpdated ? '#166534' : '#1e40af';
  const updateBanner = isUpdated
    ? `<div style="margin-top: 16px; padding: 12px 16px; background: #f0fdf4; border-left: 4px solid #22c55e; border-radius: 4px; color: #14532d;">
         <strong>🚀 CI/CD Release Update (${version}):</strong> Giao diện đã được cập nhật tự động thông qua Jenkins Pipeline (Git Tag Trigger) &amp; ArgoCD GitOps!
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Cloud Final Assignment - B23DCKH130</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #f8fafc; color: #1e293b; }
    .card { background: white; padding: 24px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; }
    h1 { color: #0f172a; margin-top: 0; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; background: ${badgeBg}; color: ${badgeColor}; font-weight: bold; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Cloud Training 2026 - Final Assignment</h1>
    <p><strong>Sinh viên:</strong> Nguyễn Vĩnh Tùng - <strong>MSSV:</strong> B23DCKH130</p>
    <p><strong>Phiên bản Web App:</strong> <span class="badge">${version}</span></p>
    <p><strong>Kiến trúc:</strong> Kubernetes + Helm + Jenkins CI/CD + ArgoCD + Prometheus + EFK + HAProxy TLS</p>
    ${updateBanner}
  </div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  webRequests++;
  const parsedUrl = url.parse(req.url, true);

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'web-app',
    http_method: req.method,
    request_path: parsedUrl.pathname,
    response_code: 200
  }));

  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (parsedUrl.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    return res.end(`# HELP web_http_requests_total Total web requests\n# TYPE web_http_requests_total counter\nweb_http_requests_total ${webRequests}\n`);
  }

  const displayVersion = parsedUrl.query.v || (parsedUrl.pathname === '/v1.0.0' ? 'v1.0.0' : APP_VERSION);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderHtml(displayVersion));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web App listening on port ${PORT}`);
});
