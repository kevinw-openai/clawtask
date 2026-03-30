import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".clawtask", "tasks.db");

export function resolveDbPath(explicitPath?: string): string {
  return explicitPath ?? process.env.CLAWTASK_DB ?? DEFAULT_DB_PATH;
}

export function openDatabase(explicitPath?: string): Database.Database {
  const dbPath = resolveDbPath(explicitPath);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT NULL REFERENCES tasks(id),
      created_by_agent_id TEXT NOT NULL,
      assigned_to_agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      cancel_requested_at TEXT NULL,
      claimed_at TEXT NULL,
      finished_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      actor_agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status_updated
      ON tasks(assigned_to_agent_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by_updated
      ON tasks(created_by_agent_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent
      ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_task_id_id
      ON task_events(task_id, id);
  `);
}
