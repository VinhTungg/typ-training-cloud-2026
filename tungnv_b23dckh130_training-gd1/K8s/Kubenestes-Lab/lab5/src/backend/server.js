const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Database configuration from Environment Variables
const dbConfig = {
  host: process.env.DB_HOST || 'db-service',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root123',
  database: process.env.DB_NAME || 'lab5db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let pool = null;

// Connect to MySQL with retry loop
async function initDatabase() {
  let connected = false;
  let attempts = 0;
  const maxAttempts = 30;

  while (!connected && attempts < maxAttempts) {
    attempts++;
    try {
      console.log(`[Attempt ${attempts}/${maxAttempts}] Connecting to MySQL at ${dbConfig.host}:${dbConfig.port}...`);
      
      // Connect without db first to ensure database exists
      const conn = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
      });

      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
      await conn.end();

      // Create connection pool with database selected
      pool = mysql.createPool(dbConfig);

      // Create tables if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          author VARCHAR(100) NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed initial sample data if table is empty
      const [rows] = await pool.query('SELECT COUNT(*) as count FROM messages');
      if (rows[0].count === 0) {
        await pool.query(`
          INSERT INTO messages (author, content) VALUES
          ('Nguyễn Vĩnh Tùng (B23DCKH130)', 'Triển khai thành công ứng dụng 3-Tier Microservices trên cụm Kubernetes!'),
          ('Kubernetes Master Node', 'Pod backend đã kết nối thành công tới MySQL service qua ClusterIP DNS.'),
          ('Hệ thống Giám sát', 'Tất cả các tầng Frontend - Backend - Database đang hoạt động bình thường.');
        `);
        console.log('Seeded initial data into messages table.');
      }

      connected = true;
      console.log('Connected to MySQL successfully!');
    } catch (err) {
      console.error(`Database connection failed: ${err.message}. Retrying in 3 seconds...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// 1. Health check endpoint
app.get('/api/health', async (req, res) => {
  let dbStatus = 'DISCONNECTED';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'CONNECTED';
    } catch (e) {
      dbStatus = `ERROR: ${e.message}`;
    }
  }

  res.json({
    status: dbStatus === 'CONNECTED' ? 'HEALTHY' : 'DEGRADED',
    tier: 'Backend API Service',
    podName: os.hostname(),
    podIP: req.socket.localAddress,
    database: {
      host: dbConfig.host,
      database: dbConfig.database,
      status: dbStatus,
    },
    timestamp: new Date().toISOString(),
  });
});

// 2. Student Info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    student: {
      name: 'Nguyễn Vĩnh Tùng',
      studentId: 'B23DCKH130',
      program: 'TYP Cloud Training 2026',
      lab: 'Lab 5: Practice Deploy Microservices (3-Tier)',
    },
    cluster: {
      backendPod: os.hostname(),
      uptimeSeconds: Math.floor(process.uptime()),
    },
  });
});

// 3. Get all messages
app.get('/api/messages', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Database not initialized' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM messages ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Create new message
app.post('/api/messages', async (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) {
    return res.status(400).json({ error: 'Author and content are required' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO messages (author, content) VALUES (?, ?)',
      [author, content]
    );
    res.status(201).json({ success: true, id: result.insertId, author, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Delete message
app.delete('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM messages WHERE id = ?', [id]);
    res.json({ success: true, message: `Message ${id} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend API listening on port ${PORT}`);
  initDatabase();
});

