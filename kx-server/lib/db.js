// lib/db.js — database access for KX-Results.
//
// Uses Node's built-in sqlite module (Node >= 22.5). Its API intentionally
// mirrors better-sqlite3, so if you later prefer that package:
//     npm install better-sqlite3
//     const Database = require('better-sqlite3');
//     const db = new Database(file);
// ...and everything else in this codebase keeps working unchanged.

'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_FILE = path.join(__dirname, '..', 'schema.sql');

function open(file = path.join(__dirname, '..', 'kx.db')) {
  const isNew = file === ':memory:' || !fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (isNew) {
    db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  }
  return db;
}

const uuid = () => randomUUID();

module.exports = { open, uuid };
