const path = require("path");
const Database = require("better-sqlite3");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const usePostgres = !!DATABASE_URL;

let sqliteDb;
let pgPool;

if (usePostgres) {
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
} else {
  const dbPath = path.join(__dirname, "bot.db");
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
}

// Initialize tables
async function init() {
  if (usePostgres) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        first_name TEXT,
        username TEXT,
        joined_at TIMESTAMP DEFAULT NOW(),
        last_activity TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS movies (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        file_id TEXT NOT NULL,
        file_type TEXT,
        poster_file_id TEXT,
        uploaded_by_id TEXT,
        uploaded_at TIMESTAMP DEFAULT NOW(),
        channel_message_id BIGINT
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'kichkina_admin',
        added_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        first_name TEXT,
        username TEXT,
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_activity TEXT
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS movies (
        id INTEGER PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        file_id TEXT NOT NULL,
        file_type TEXT,
        poster_file_id TEXT,
        uploaded_by_id TEXT,
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        channel_message_id INTEGER
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'kichkina_admin',
        added_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: ensure 'role' column exists (for older DBs)
    try {
      const cols = sqliteDb.prepare("PRAGMA table_info(admins)").all();
      const hasRole = cols.some((c) => c.name === "role");
      if (!hasRole) {
        sqliteDb.exec(
          "ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'kichkina_admin'",
        );
      }
    } catch (err) {
      // ignore
    }
  }
}

// Users
async function addUser(userId, firstName, username) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO users (user_id, first_name, username, last_activity) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [userId, firstName, username],
    );
    return { success: true };
  }
  const stmt = sqliteDb.prepare(
    `INSERT OR IGNORE INTO users (user_id, first_name, username, last_activity) VALUES (?, ?, ?, datetime('now'))`,
  );
  return stmt.run(userId, firstName, username);
}

async function getUserById(userId) {
  if (usePostgres) {
    const res = await pgPool.query(`SELECT * FROM users WHERE user_id = $1`, [
      userId,
    ]);
    return res.rows[0];
  }
  const stmt = sqliteDb.prepare("SELECT * FROM users WHERE user_id = ?");
  return stmt.get(userId);
}

async function getAllUsers() {
  if (usePostgres) {
    const res = await pgPool.query(
      `SELECT * FROM users ORDER BY joined_at DESC`,
    );
    return res.rows;
  }
  const stmt = sqliteDb.prepare("SELECT * FROM users ORDER BY joined_at DESC");
  return stmt.all();
}

async function updateLastActivity(userId) {
  if (usePostgres) {
    return pgPool.query(
      `UPDATE users SET last_activity = NOW() WHERE user_id = $1`,
      [userId],
    );
  }
  const stmt = sqliteDb.prepare(
    "UPDATE users SET last_activity = datetime('now') WHERE user_id = ?",
  );
  return stmt.run(userId);
}

// Movies
async function addMovie(
  code,
  name,
  fileId,
  fileType,
  posterFileId,
  uploadedById,
) {
  if (usePostgres) {
    return pgPool.query(
      `INSERT INTO movies (code, name, file_id, file_type, poster_file_id, uploaded_by_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING`,
      [code, name, fileId, fileType, posterFileId || null, uploadedById],
    );
  }
  const stmt = sqliteDb.prepare(
    `INSERT INTO movies (code, name, file_id, file_type, poster_file_id, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return stmt.run(
    code,
    name,
    fileId,
    fileType,
    posterFileId || null,
    uploadedById,
  );
}

async function getMovieByCode(code) {
  const uc = code.toUpperCase();
  if (usePostgres) {
    const res = await pgPool.query(`SELECT * FROM movies WHERE code = $1`, [
      uc,
    ]);
    return res.rows[0];
  }
  const stmt = sqliteDb.prepare("SELECT * FROM movies WHERE code = ?");
  return stmt.get(uc);
}

async function getAllMovies() {
  if (usePostgres) {
    const res = await pgPool.query(
      `SELECT * FROM movies ORDER BY uploaded_at DESC`,
    );
    return res.rows;
  }
  const stmt = sqliteDb.prepare(
    "SELECT * FROM movies ORDER BY uploaded_at DESC",
  );
  return stmt.all();
}

async function deleteMovieByCode(code) {
  const uc = code.toUpperCase();
  if (usePostgres) {
    return pgPool.query(`DELETE FROM movies WHERE code = $1`, [uc]);
  }
  const stmt = sqliteDb.prepare("DELETE FROM movies WHERE code = ?");
  return stmt.run(uc);
}

// Admins
async function isAdmin(userId) {
  if (usePostgres) {
    const res = await pgPool.query(`SELECT * FROM admins WHERE user_id = $1`, [
      userId,
    ]);
    return res.rowCount > 0;
  }
  const stmt = sqliteDb.prepare("SELECT * FROM admins WHERE user_id = ?");
  return stmt.get(userId) !== undefined;
}

async function getAdminRole(userId) {
  if (usePostgres) {
    const res = await pgPool.query(
      `SELECT role FROM admins WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0] ? res.rows[0].role : null;
  }
  const stmt = sqliteDb.prepare("SELECT role FROM admins WHERE user_id = ?");
  const result = stmt.get(userId);
  return result ? result.role : null;
}

async function addAdmin(userId, role = "kichkina_admin") {
  if (usePostgres) {
    return pgPool.query(
      `INSERT INTO admins (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
      [userId, role],
    );
  }
  const stmt = sqliteDb.prepare(
    "INSERT OR IGNORE INTO admins (user_id, role) VALUES (?, ?)",
  );
  return stmt.run(userId, role);
}

async function removeAdmin(userId) {
  if (usePostgres) {
    return pgPool.query(`DELETE FROM admins WHERE user_id = $1`, [userId]);
  }
  const stmt = sqliteDb.prepare("DELETE FROM admins WHERE user_id = ?");
  return stmt.run(userId);
}

async function getAllAdmins() {
  if (usePostgres) {
    const res = await pgPool.query(`SELECT * FROM admins`);
    return res.rows;
  }
  const stmt = sqliteDb.prepare("SELECT * FROM admins");
  return stmt.all();
}

module.exports = {
  init,
  addUser,
  getUserById,
  getAllUsers,
  updateLastActivity,
  addMovie,
  getMovieByCode,
  getAllMovies,
  deleteMovieByCode,
  isAdmin,
  getAdminRole,
  addAdmin,
  removeAdmin,
  getAllAdmins,
};
