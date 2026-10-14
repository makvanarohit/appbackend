import mysql from 'mysql2/promise';
import { env } from './env';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  // How JavaScript Date objects are converted to and from MySQL DATETIME.
  // 'Z' = always UTC, whatever time zone this computer is set to.
  timezone: 'Z',
});

// Make every new connection use UTC inside MySQL too, so NOW() and
// DEFAULT CURRENT_TIMESTAMP write UTC, no matter the MySQL server's own
// time zone. The command runs before any query that uses the connection.
pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err) console.error('[database] could not set session time zone to UTC:', err.message);
  });
});

export async function pingDatabase(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT @@session.time_zone AS tz');
    const tz = rows[0]?.tz;
    if (tz !== '+00:00') {
      throw new Error(`Database session time zone must be UTC (+00:00), got: ${String(tz)}`);
    }
  } finally {
    conn.release();
  }
}