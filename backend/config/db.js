// Env-driven MariaDB connection pool (Node.js side of the backend).
// Never hardcode credentials here — everything comes from process.env,
// loaded from .env via dotenv in the process entrypoint.

const mysql = require('mysql2/promise');

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildPoolConfig() {
  return {
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONN_LIMIT || 10),
    queueLimit: 0,
    dateStrings: false,
    timezone: 'Z', // store/read DATETIME as UTC per Master Reference Rule 31
  };
}

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(buildPoolConfig());
  }
  return pool;
}

module.exports = { getPool };
