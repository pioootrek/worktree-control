import type Database from "better-sqlite3";

/** A thread row as the operation writes it; every value was validated by the operation. */
export interface KnowledgeThreadRow {
  id: string; projectId: string; title: string; body: string; revision: number;
  createdBy: string; createdAt: string; updatedAt: string;
}
/** The author columns of the thread's `created` history row. */
export interface KnowledgeHistoryAuthor { principalId: string; authenticationMethod: string }

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("Expected text.");
  return value;
};

/**
 * The write port of `knowledge.create_thread` (D2b-2) on the store's owned
 * core connection: two write-free reads that the operation needs before its
 * commit point, and the thread with its `created` history row in one
 * transaction. It opens no connection, reads and writes no
 * `knowledge_idempotency` row and runs no authorization. Call within an
 * admitted core phase; the operation validates every answer.
 */
export class KnowledgeThreadWriterQueries {
  constructor(private readonly database: Database.Database) {}

  /** The stored status of a Knowledge project, or null when it has no row. */
  projectStatus(projectId: string): unknown {
    const row = this.database.prepare("SELECT status FROM knowledge_projects WHERE id=?").get(text(projectId)) as { status: unknown } | undefined;
    return row ? row.status : null;
  }

  /** The stored kind and status of a principal, or null when it has no row. */
  principal(id: string): unknown {
    const row = this.database.prepare("SELECT kind,status FROM remote_principals WHERE id=?").get(text(id)) as { kind: unknown; status: unknown } | undefined;
    return row ? { kind: row.kind, status: row.status } : null;
  }

  /**
   * Inserts the thread and its `created` history row in one immediate
   * transaction, with the column order and values of the legacy write. A
   * failure of either insert rolls both back and throws.
   */
  createThread(thread: KnowledgeThreadRow, author: KnowledgeHistoryAuthor): void {
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO knowledge_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(text(thread.id), text(thread.projectId), text(thread.title), text(thread.body), thread.revision, text(thread.createdBy), text(thread.createdAt), text(thread.updatedAt));
      this.database.prepare(`INSERT INTO knowledge_history(project_id, record_kind, record_id, operation, previous_json, principal_id, authentication_method, revision, created_at)
        VALUES (?, 'thread', ?, 'created', NULL, ?, ?, ?, ?)`)
        .run(thread.projectId, thread.id, text(author.principalId), text(author.authenticationMethod), thread.revision, thread.createdAt);
    }).immediate();
  }
}
