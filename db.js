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
        channel_message_id BIGINT,
        genre TEXT,
        year TEXT,
        language TEXT,
        duration TEXT
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

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        channel_id TEXT UNIQUE NOT NULL,
        channel_username TEXT,
        channel_title TEXT,
        added_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Migration: ensure 'channel_title' column exists (for older DBs)
    try {
      await pgPool.query(
        `ALTER TABLE channels ADD COLUMN IF NOT EXISTS channel_title TEXT`,
      );
    } catch (err) {
      // ignore
    }

    // Migration: ensure new movie metadata columns exist (for older DBs)
    try {
      await pgPool.query(
        `ALTER TABLE movies ADD COLUMN IF NOT EXISTS genre TEXT`,
      );
    } catch (err) {
      // ignore
    }
    try {
      await pgPool.query(
        `ALTER TABLE movies ADD COLUMN IF NOT EXISTS year TEXT`,
      );
    } catch (err) {
      // ignore
    }
    try {
      await pgPool.query(
        `ALTER TABLE movies ADD COLUMN IF NOT EXISTS language TEXT`,
      );
    } catch (err) {
      // ignore
    }
    try {
      await pgPool.query(
        `ALTER TABLE movies ADD COLUMN IF NOT EXISTS duration TEXT`,
      );
    } catch (err) {
      // ignore
    }
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
        channel_message_id INTEGER,
        genre TEXT,
        year TEXT,
        language TEXT,
        duration TEXT
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

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        channel_id TEXT UNIQUE NOT NULL,
        channel_username TEXT,
        channel_title TEXT,
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

    // Migration: ensure 'channel_title' column exists (for older DBs)
    try {
      const cols = sqliteDb.prepare("PRAGMA table_info(channels)").all();
      const hasTitle = cols.some((c) => c.name === "channel_title");
      if (!hasTitle) {
        sqliteDb.exec("ALTER TABLE channels ADD COLUMN channel_title TEXT");
      }
    } catch (err) {
      // ignore
    }

    // Migration: ensure new movie metadata columns exist (for older DBs)
    try {
      const cols = sqliteDb.prepare("PRAGMA table_info(movies)").all();
      const movieColumns = ["genre", "year", "language", "duration"];
      for (const col of movieColumns) {
        const hasColumn = cols.some((c) => c.name === col);
        if (!hasColumn) {
          sqliteDb.exec(`ALTER TABLE movies ADD COLUMN ${col} TEXT`);
        }
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
  genre = null,
  year = null,
  language = null,
  duration = null,
  channelMessageId = null,
) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO movies (code, name, file_id, file_type, poster_file_id, uploaded_by_id, genre, year, language, duration, channel_message_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (code) DO NOTHING`,
      [
        code,
        name,
        fileId,
        fileType,
        posterFileId || null,
        uploadedById,
        genre || null,
        year || null,
        language || null,
        duration || null,
        channelMessageId || null,
      ],
    );
    return { success: true };
  }
  const stmt = sqliteDb.prepare(
    `INSERT OR IGNORE INTO movies (code, name, file_id, file_type, poster_file_id, uploaded_by_id, genre, year, language, duration, channel_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return stmt.run(
    code,
    name,
    fileId,
    fileType,
    posterFileId || null,
    uploadedById,
    genre || null,
    year || null,
    language || null,
    duration || null,
    channelMessageId || null,
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

// Channels
async function addChannel(channelId, channelUsername, channelTitle) {
  if (usePostgres) {
    return pgPool.query(
      `INSERT INTO channels (channel_id, channel_username, channel_title) VALUES ($1, $2, $3) ON CONFLICT (channel_id) DO NOTHING`,
      [channelId, channelUsername || null, channelTitle || null],
    );
  }
  const stmt = sqliteDb.prepare(
    "INSERT OR IGNORE INTO channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)",
  );
  return stmt.run(channelId, channelUsername || null, channelTitle || null);
}

async function getAllChannels() {
  if (usePostgres) {
    const res = await pgPool.query(
      `SELECT * FROM channels ORDER BY added_at DESC`,
    );
    return res.rows;
  }
  const stmt = sqliteDb.prepare(
    "SELECT * FROM channels ORDER BY added_at DESC",
  );
  return stmt.all();
}

async function deleteChannel(channelId) {
  if (usePostgres) {
    return pgPool.query(`DELETE FROM channels WHERE channel_id = $1`, [
      channelId,
    ]);
  }
  const stmt = sqliteDb.prepare("DELETE FROM channels WHERE channel_id = ?");
  return stmt.run(channelId);
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
  addChannel,
  getAllChannels,
  deleteChannel,
  close: async () => {
    try {
      if (usePostgres && pgPool) await pgPool.end();
    } catch (err) {
      // ignore
    }
  },
};
