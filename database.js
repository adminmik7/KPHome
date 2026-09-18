const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const MAIN_DB_PATH = path.join(__dirname, 'data', 'data.sqlite');
const KP_DB_PATH = path.join(__dirname, 'data', 'kp.sqlite');
let mainDb = null;
let kpDb = null;

async function initDatabase() {
    const SQL = await initSqlJs();

    if (fs.existsSync(MAIN_DB_PATH)) {
        mainDb = new SQL.Database(fs.readFileSync(MAIN_DB_PATH));
    } else {
        mainDb = new SQL.Database();
    }

    mainDb.run(`CREATE TABLE IF NOT EXISTS users (
        login TEXT PRIMARY KEY,
        passw TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        executor TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        email TEXT DEFAULT ''
    )`);
    mainDb.run(`CREATE TABLE IF NOT EXISTS todo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        contactDate TEXT
    )`);
    mainDb.run(`CREATE TABLE IF NOT EXISTS endpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        url TEXT DEFAULT '',
        enabled INTEGER DEFAULT 0
    )`);
    mainDb.run(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL
    )`);
    mainDb.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        channel TEXT,
        from_user TEXT NOT NULL,
        to_user TEXT,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL
    )`);
    mainDb.run(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'todo',
        userId TEXT DEFAULT '',
        executor TEXT DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT
    )`);
    mainDb.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`);

    saveMainDb();
    return mainDb;
}

async function initKpDatabase() {
    const SQL = await initSqlJs();

    if (fs.existsSync(KP_DB_PATH)) {
        kpDb = new SQL.Database(fs.readFileSync(KP_DB_PATH));
    } else {
        kpDb = new SQL.Database();
    }

    kpDb.run(`CREATE TABLE IF NOT EXISTS kp_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
    )`);

    saveKpDb();
    return kpDb;
}

function saveMainDb() {
    if (!mainDb) return;
    fs.writeFileSync(MAIN_DB_PATH, Buffer.from(mainDb.export()));
}

function saveKpDb() {
    if (!kpDb) return;
    fs.writeFileSync(KP_DB_PATH, Buffer.from(kpDb.export()));
}

function queryAll(sql, params = []) {
    const stmt = mainDb.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results.length > 0 ? results[0] : null;
}

function run(sql, params = []) {
    mainDb.run(sql, params);
    saveMainDb();
}

function kpQueryAll(sql, params = []) {
    const stmt = kpDb.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function kpQueryOne(sql, params = []) {
    const results = kpQueryAll(sql, params);
    return results.length > 0 ? results[0] : null;
}

function kpRun(sql, params = []) {
    kpDb.run(sql, params);
    saveKpDb();
}

module.exports = { initDatabase, initKpDatabase, queryAll, queryOne, run, kpQueryAll, kpQueryOne, kpRun };
