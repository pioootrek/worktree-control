import Database from "better-sqlite3";

/** Built-in test profiles every project starts with; see `test-environment.ts`. */
const DEFAULT_TEST_PROFILES_JSON = JSON.stringify([
  { name: "unit", policy: { mode: "clean", serverProfile: null }, environment: {}, nodeEnv: "test", requiredVariables: [] },
  { name: "tooling", policy: { mode: "clean", serverProfile: null }, environment: {}, nodeEnv: null, requiredVariables: [] },
]);

const REMOTE_VERIFICATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS remote_principals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('owner', 'agent', 'worker')),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))
  );

  CREATE TABLE IF NOT EXISTS remote_project_identities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_remote TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))
  );

  CREATE TABLE IF NOT EXISTS remote_workers (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE REFERENCES remote_principals(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    last_contact_at TEXT
  );

  CREATE TABLE IF NOT EXISTS remote_principal_project_grants (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    project_id TEXT NOT NULL REFERENCES remote_project_identities(id),
    permissions_json TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(principal_id, project_id)
  );

  CREATE TABLE IF NOT EXISTS remote_worker_project_grants (
    worker_id TEXT NOT NULL REFERENCES remote_workers(id),
    project_id TEXT NOT NULL REFERENCES remote_project_identities(id),
    local_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    preset_ids_json TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(worker_id, project_id)
  );

  CREATE TABLE IF NOT EXISTS remote_verification_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES remote_project_identities(id),
    worker_id TEXT NOT NULL REFERENCES remote_workers(id),
    requested_by TEXT NOT NULL REFERENCES remote_principals(id),
    commit_sha TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('pending', 'assigned', 'completed', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(requested_by, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS remote_verification_requests_queue
    ON remote_verification_requests(phase, created_at, id);
`;

const REMOTE_VERIFICATION_ATTEMPT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS remote_verification_attempts (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES remote_verification_requests(id),
    worker_id TEXT NOT NULL REFERENCES remote_workers(id),
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    phase TEXT NOT NULL CHECK(phase IN (
      'assigned', 'preparing', 'running', 'succeeded', 'failed',
      'cancel_requested', 'cancelled', 'uncertain'
    )),
    version INTEGER NOT NULL CHECK(version > 0),
    local_run_id TEXT,
    executed_commit_sha TEXT,
    failure_kind TEXT CHECK(failure_kind IN ('setup', 'execution')),
    error_code TEXT,
    accepted_at TEXT NOT NULL,
    last_reported_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(request_id, sequence)
  );

  CREATE INDEX IF NOT EXISTS remote_verification_attempts_request
    ON remote_verification_attempts(request_id, sequence DESC);
`;

const IDENTITY_AND_KNOWLEDGE_ACCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS principal_credentials (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    kind TEXT NOT NULL CHECK(kind IN ('owner_session', 'agent_token', 'worker_token')),
    label TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    verifier_hash TEXT NOT NULL UNIQUE CHECK(length(verifier_hash) = 64),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    expires_at TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS principal_credentials_principal
    ON principal_credentials(principal_id, created_at, id);

  CREATE TABLE IF NOT EXISTS knowledge_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_project_grants (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    permissions_json TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(principal_id, project_id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_project_runtime_links (
    knowledge_project_id TEXT PRIMARY KEY REFERENCES knowledge_projects(id),
    runtime_project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE SET NULL,
    linked_at TEXT NOT NULL,
    unlinked_at TEXT
  );
`;

const KNOWLEDGE_CONTENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS knowledge_threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_by TEXT NOT NULL REFERENCES remote_principals(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_threads_project ON knowledge_threads(project_id, updated_at DESC, id);

  CREATE TABLE IF NOT EXISTS knowledge_replies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    thread_id TEXT NOT NULL REFERENCES knowledge_threads(id),
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_by TEXT NOT NULL REFERENCES remote_principals(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_replies_thread ON knowledge_replies(project_id, thread_id, created_at, id);

  CREATE TABLE IF NOT EXISTS knowledge_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'blocked', 'done', 'archived')),
    priority TEXT NOT NULL CHECK(priority IN ('now', 'next', 'later')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_by TEXT NOT NULL REFERENCES remote_principals(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_tasks_project ON knowledge_tasks(project_id, updated_at DESC, id);

  CREATE TABLE IF NOT EXISTS knowledge_relations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    type TEXT NOT NULL CHECK(type IN ('derived_from', 'blocks', 'relates_to', 'supersedes')),
    source_kind TEXT NOT NULL CHECK(source_kind IN ('thread', 'reply', 'task')),
    source_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('thread', 'reply', 'task')),
    target_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_by TEXT NOT NULL REFERENCES remote_principals(id),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, type, source_kind, source_id, target_kind, target_id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    record_kind TEXT NOT NULL CHECK(record_kind IN ('project', 'thread', 'reply', 'task', 'relation')),
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('created', 'updated', 'archived', 'linked', 'unlinked')),
    previous_json TEXT,
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    authentication_method TEXT NOT NULL CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_history_record ON knowledge_history(project_id, record_kind, record_id, id);

  CREATE TABLE IF NOT EXISTS knowledge_idempotency (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(principal_id, project_id, operation, idempotency_key)
  );
`;

const schema = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repository_path TEXT NOT NULL UNIQUE,
    port INTEGER NOT NULL UNIQUE CHECK(port BETWEEN 1 AND 65535),
    launch_preset TEXT NOT NULL DEFAULT 'node' CHECK(launch_preset IN ('auto', 'node', 'django')),
    tls_mode TEXT NOT NULL DEFAULT 'off' CHECK(tls_mode IN ('off', 'generated', 'custom')),
    tls_key_path TEXT,
    tls_cert_path TEXT,
    tls_ca_path TEXT,
    executable TEXT NOT NULL,
    args_json TEXT NOT NULL,
    environment_json TEXT NOT NULL DEFAULT '{}',
    environment_profiles_json TEXT NOT NULL DEFAULT '[{"name":"default","environment":{}}]',
    selected_environment_profile TEXT NOT NULL DEFAULT 'default',
    test_environment_profiles_json TEXT NOT NULL DEFAULT '${DEFAULT_TEST_PROFILES_JSON}',
    test_preset_profiles_json TEXT NOT NULL DEFAULT '{}',
    healthcheck_path TEXT NOT NULL,
    startup_timeout_ms INTEGER NOT NULL,
    selected_worktree_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worktree_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('human', 'agent')),
    owner TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    maximum_expires_at TEXT,
    token_hash TEXT,
    idempotency_key TEXT,
    released_at TEXT,
    released_by TEXT,
    CHECK(
      (kind = 'human' AND expires_at IS NULL AND maximum_expires_at IS NULL AND token_hash IS NULL)
      OR
      (kind = 'agent' AND expires_at IS NOT NULL AND maximum_expires_at IS NOT NULL AND token_hash IS NOT NULL AND idempotency_key IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation_per_project
    ON reservations(project_id) WHERE released_at IS NULL;

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS controller_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS controller_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worktree_path TEXT NOT NULL,
    worktree_head TEXT NOT NULL,
    worktree_branch TEXT,
    worktree_dirty INTEGER NOT NULL CHECK(worktree_dirty IN (0, 1)),
    preset_id TEXT NOT NULL,
    preset_name TEXT NOT NULL,
    adapter TEXT NOT NULL CHECK(adapter IN ('node', 'django')),
    actor TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued', 'running', 'passed', 'failed', 'cancelled', 'timed_out', 'interrupted')),
    queue_position INTEGER,
    executable TEXT NOT NULL,
    args_json TEXT NOT NULL,
    cwd TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    signal TEXT,
    error TEXT,
    logs_json TEXT NOT NULL DEFAULT '[]',
    idempotency_key TEXT,
    environment_mode TEXT NOT NULL DEFAULT 'clean' CHECK(environment_mode IN ('clean', 'inherit-server-profile')),
    environment_profile TEXT NOT NULL DEFAULT 'unit',
    inherited_server_profile TEXT,
    environment_variable_names_json TEXT NOT NULL DEFAULT '[]',
    source_json TEXT
  );

  CREATE INDEX IF NOT EXISTS test_runs_project_history ON test_runs(project_id, queued_at DESC);
  CREATE INDEX IF NOT EXISTS test_runs_phase_queue ON test_runs(phase, queued_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS test_runs_actor_idempotency
    ON test_runs(actor, idempotency_key) WHERE idempotency_key IS NOT NULL;

  ${REMOTE_VERIFICATION_SCHEMA}
  ${REMOTE_VERIFICATION_ATTEMPT_SCHEMA}
  ${IDENTITY_AND_KNOWLEDGE_ACCESS_SCHEMA}
  ${KNOWLEDGE_CONTENT_SCHEMA}

  INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;

export function initializeSchema(database: Database.Database): void {
  database.exec(schema);
  applyMigrations(database);
}

function applyMigrations(database: Database.Database): void {
  if (!hasMigration(database, 2)) {
    database.transaction(() => {
      database.prepare(`
        UPDATE projects SET args_json = '["run","dev"]', updated_at = ?
        WHERE executable = 'pnpm' AND args_json LIKE '["dev","--","--port",%'
      `).run(new Date().toISOString());
      recordMigration(database, 2);
    })();
  }
  if (!hasMigration(database, 3)) {
    database.transaction(() => {
      const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const names = new Set(columns.map(({ name }) => name));
      if (!names.has("tls_mode")) database.exec("ALTER TABLE projects ADD COLUMN tls_mode TEXT NOT NULL DEFAULT 'off' CHECK(tls_mode IN ('off', 'generated', 'custom'))");
      if (!names.has("tls_key_path")) database.exec("ALTER TABLE projects ADD COLUMN tls_key_path TEXT");
      if (!names.has("tls_cert_path")) database.exec("ALTER TABLE projects ADD COLUMN tls_cert_path TEXT");
      if (!names.has("tls_ca_path")) database.exec("ALTER TABLE projects ADD COLUMN tls_ca_path TEXT");
      recordMigration(database, 3);
    })();
  }
  if (!hasMigration(database, 4)) {
    database.transaction(() => {
      const columns = database.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>;
      const names = new Set(columns.map(({ name }) => name));
      if (!names.has("maximum_expires_at")) database.exec("ALTER TABLE reservations ADD COLUMN maximum_expires_at TEXT");
      if (!names.has("token_hash")) database.exec("ALTER TABLE reservations ADD COLUMN token_hash TEXT");
      if (!names.has("idempotency_key")) database.exec("ALTER TABLE reservations ADD COLUMN idempotency_key TEXT");
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS active_agent_idempotency_key
        ON reservations(owner, idempotency_key)
        WHERE kind = 'agent' AND released_at IS NULL AND idempotency_key IS NOT NULL
      `);
      recordMigration(database, 4);
    })();
  }
  if (!hasMigration(database, 5)) {
    database.transaction(() => {
      database.prepare(`
        INSERT OR IGNORE INTO controller_settings(key, value_json, updated_at)
        VALUES ('server_capacity', ?, ?)
      `).run(JSON.stringify({ enabled: false, limit: 2 }), new Date().toISOString());
      recordMigration(database, 5);
    })();
  }
  if (!hasMigration(database, 6)) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS worktree_storage_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          worktree_path TEXT NOT NULL,
          total_bytes INTEGER NOT NULL,
          next_bytes INTEGER NOT NULL,
          next_cache_bytes INTEGER NOT NULL,
          node_modules_bytes INTEGER NOT NULL,
          top_directories_json TEXT NOT NULL,
          measured_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS worktree_storage_history
          ON worktree_storage_samples(project_id, worktree_path, measured_at);
      `);
      recordMigration(database, 6);
    })();
  }
  if (!hasMigration(database, 7)) {
    database.transaction(() => {
      const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "launch_preset")) {
        database.exec("ALTER TABLE projects ADD COLUMN launch_preset TEXT NOT NULL DEFAULT 'node' CHECK(launch_preset IN ('auto', 'node', 'django'))");
      }
      recordMigration(database, 7);
    })();
  }
  if (!hasMigration(database, 8)) {
    database.transaction(() => {
      const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "environment_json")) {
        database.exec("ALTER TABLE projects ADD COLUMN environment_json TEXT NOT NULL DEFAULT '{}'");
      }
      recordMigration(database, 8);
    })();
  }
  if (!hasMigration(database, 9)) {
    database.transaction(() => {
      const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const names = new Set(columns.map(({ name }) => name));
      const addedProfilesColumn = !names.has("environment_profiles_json");
      if (addedProfilesColumn) {
        database.exec(`ALTER TABLE projects ADD COLUMN environment_profiles_json TEXT NOT NULL DEFAULT '[{"name":"default","environment":{}}]'`);
      }
      if (!names.has("selected_environment_profile")) {
        database.exec("ALTER TABLE projects ADD COLUMN selected_environment_profile TEXT NOT NULL DEFAULT 'default'");
      }
      if (addedProfilesColumn) {
        database.prepare(`
          UPDATE projects SET environment_profiles_json = json_array(json_object('name', 'default', 'environment', json(environment_json)))
        `).run();
      }
      recordMigration(database, 9);
    })();
  }
  if (!hasMigration(database, 10)) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS test_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          worktree_path TEXT NOT NULL,
          worktree_head TEXT NOT NULL,
          worktree_branch TEXT,
          worktree_dirty INTEGER NOT NULL CHECK(worktree_dirty IN (0, 1)),
          preset_id TEXT NOT NULL,
          preset_name TEXT NOT NULL,
          adapter TEXT NOT NULL CHECK(adapter IN ('node', 'django')),
          actor TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('queued', 'running', 'passed', 'failed', 'cancelled', 'timed_out', 'interrupted')),
          queue_position INTEGER,
          executable TEXT NOT NULL,
          args_json TEXT NOT NULL,
          cwd TEXT NOT NULL,
          queued_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          exit_code INTEGER,
          signal TEXT,
          error TEXT,
          logs_json TEXT NOT NULL DEFAULT '[]',
          idempotency_key TEXT
        );
        CREATE INDEX IF NOT EXISTS test_runs_project_history ON test_runs(project_id, queued_at DESC);
        CREATE INDEX IF NOT EXISTS test_runs_phase_queue ON test_runs(phase, queued_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS test_runs_actor_idempotency
          ON test_runs(actor, idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
      database.prepare(`
        INSERT OR IGNORE INTO controller_settings(key, value_json, updated_at)
        VALUES ('test_queue', ?, ?)
      `).run(JSON.stringify({ limit: 1 }), new Date().toISOString());
      recordMigration(database, 10);
    })();
  }
  if (!hasMigration(database, 11)) {
    database.transaction(() => {
      const projectColumns = new Set((database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!projectColumns.has("test_environment_profiles_json")) {
        database.exec(`ALTER TABLE projects ADD COLUMN test_environment_profiles_json TEXT NOT NULL DEFAULT '${DEFAULT_TEST_PROFILES_JSON}'`);
      }
      if (!projectColumns.has("test_preset_profiles_json")) {
        database.exec("ALTER TABLE projects ADD COLUMN test_preset_profiles_json TEXT NOT NULL DEFAULT '{}'");
      }
      const runColumns = new Set((database.prepare("PRAGMA table_info(test_runs)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!runColumns.has("environment_mode")) {
        // Historical runs predate the policy, so they are recorded as the inheriting behaviour they actually had.
        database.exec("ALTER TABLE test_runs ADD COLUMN environment_mode TEXT NOT NULL DEFAULT 'inherit-server-profile'");
        database.exec("ALTER TABLE test_runs ADD COLUMN environment_profile TEXT NOT NULL DEFAULT 'legacy'");
        database.exec("ALTER TABLE test_runs ADD COLUMN inherited_server_profile TEXT");
        database.exec("ALTER TABLE test_runs ADD COLUMN environment_variable_names_json TEXT NOT NULL DEFAULT '[]'");
      }
      recordMigration(database, 11);
    })();
  }
  if (!hasMigration(database, 12)) {
    database.transaction(() => {
      const columns = new Set((database.prepare("PRAGMA table_info(test_runs)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("source_json")) database.exec("ALTER TABLE test_runs ADD COLUMN source_json TEXT");
      recordMigration(database, 12);
    })();
  }
  if (!hasMigration(database, 13)) {
    database.transaction(() => {
      // Missing presets previously reached the launch resolver as undefined, which means auto.
      ensureLaunchPresetColumn(database);
      recordMigration(database, 13);
    })();
  }
  if (!hasMigration(database, 14)) {
    database.transaction(() => {
      // Migration 13 existed on the pre-merge remote-verification branch. Repeating
      // this idempotent repair preserves databases created on either lineage.
      ensureLaunchPresetColumn(database);
      database.exec(REMOTE_VERIFICATION_SCHEMA);
      recordMigration(database, 14);
    })();
  }
  if (!hasMigration(database, 15)) {
    database.transaction(() => {
      ensureLaunchPresetColumn(database);
      database.exec(REMOTE_VERIFICATION_ATTEMPT_SCHEMA);
      recordMigration(database, 15);
    })();
  }
  if (!hasMigration(database, 16)) {
    database.transaction(() => {
      database.exec("CREATE INDEX IF NOT EXISTS worktree_launch_history ON audit_events(project_id, id DESC) WHERE event_type = 'worktree.launched'");
      recordMigration(database, 16);
    })();
  }
  if (!hasMigration(database, 17)) {
    database.transaction(() => {
      database.exec(IDENTITY_AND_KNOWLEDGE_ACCESS_SCHEMA);
      recordMigration(database, 17);
    })();
  }
  if (!hasMigration(database, 18)) {
    database.transaction(() => {
      database.prepare("UPDATE principal_credentials SET token_prefix = 'wts_' || id").run();
      recordMigration(database, 18);
    })();
  }
  if (!hasMigration(database, 19)) {
    database.transaction(() => {
      database.exec(KNOWLEDGE_CONTENT_SCHEMA);
      recordMigration(database, 19);
    })();
  }
  if (!hasMigration(database, 20)) {
    database.transaction(() => {
      database.exec(`
        ALTER TABLE knowledge_history RENAME TO knowledge_history_k3;
        DROP INDEX knowledge_history_record;
      `);
      database.exec(KNOWLEDGE_CONTENT_SCHEMA
        .replace("('project', 'thread', 'reply', 'task', 'relation')", "('project', 'thread', 'reply', 'task', 'relation', 'memory')")
        .replace("('created', 'updated', 'archived', 'linked', 'unlinked')", "('created', 'updated', 'archived', 'linked', 'unlinked', 'approved', 'superseded')"));
      database.exec(`
        INSERT INTO knowledge_history SELECT * FROM knowledge_history_k3;
        DROP TABLE knowledge_history_k3;
        CREATE TABLE IF NOT EXISTS knowledge_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('decision', 'question', 'note')),
          tags_json TEXT NOT NULL,
          legacy_id TEXT,
          sources_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'archived', 'superseded')),
          superseded_by_json TEXT,
          approval_json TEXT,
          revision INTEGER NOT NULL CHECK(revision > 0),
          created_by TEXT NOT NULL REFERENCES remote_principals(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS knowledge_memories_project ON knowledge_memories(project_id, status, updated_at DESC, id);
      `);
      recordMigration(database, 20);
    })();
  }
  if (!hasMigration(database, 21)) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_attachments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
          record_kind TEXT NOT NULL CHECK(record_kind IN ('thread','reply','task','memory')),
          record_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size >= 0),
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          created_by TEXT NOT NULL REFERENCES remote_principals(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS knowledge_attachments_record ON knowledge_attachments(project_id, record_kind, record_id, created_at, id);
      `);
      recordMigration(database, 21);
    })();
  }
  if (!hasMigration(database, 22)) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_import_batches (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          plan_hash TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_repository TEXT NOT NULL,
          source_commit TEXT NOT NULL CHECK(length(source_commit) = 40),
          target_project_id TEXT NOT NULL,
          target_project_name TEXT NOT NULL,
          expected_target_revision INTEGER CHECK(expected_target_revision > 0),
          actor_principal_id TEXT NOT NULL REFERENCES remote_principals(id),
          status TEXT NOT NULL CHECK(status IN ('staging','published','failed')),
          cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
          total_items INTEGER NOT NULL CHECK(total_items >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          published_at TEXT,
          error TEXT,
          UNIQUE(source_id, source_commit, plan_hash, target_project_id)
        );
        CREATE INDEX IF NOT EXISTS knowledge_import_batches_target
          ON knowledge_import_batches(target_project_id, created_at, id);

        CREATE TABLE IF NOT EXISTS knowledge_import_staging (
          batch_id TEXT NOT NULL REFERENCES knowledge_import_batches(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          mapping_json TEXT NOT NULL,
          PRIMARY KEY(batch_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS knowledge_import_sources (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
          batch_id TEXT REFERENCES knowledge_import_batches(id),
          source_id TEXT NOT NULL,
          source_repository TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          source_path TEXT NOT NULL,
          legacy_id TEXT,
          source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
          mapping_version INTEGER NOT NULL,
          target_kind TEXT,
          target_id TEXT,
          original_payload_json TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(project_id, source_id, legacy_id, source_path)
        );
        CREATE INDEX IF NOT EXISTS knowledge_import_sources_project
          ON knowledge_import_sources(project_id, source_path, id);
      `);
      recordMigration(database, 22);
    })();
  }

  if (!hasMigration(database, 23)) {
    database.transaction(() => {
      const columns = new Set((database.prepare("PRAGMA table_info(knowledge_import_sources)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("target_revision")) database.exec(`ALTER TABLE knowledge_import_sources ADD COLUMN target_revision INTEGER CHECK(target_revision IS NULL OR target_revision > 0)`);
      recordMigration(database, 23);
    })();
  }

  if (!hasMigration(database, 24)) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE knowledge_import_sources_v24 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
          batch_id TEXT REFERENCES knowledge_import_batches(id),
          source_id TEXT NOT NULL,
          source_repository TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          source_path TEXT NOT NULL,
          legacy_id TEXT,
          source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
          mapping_version INTEGER NOT NULL,
          target_kind TEXT,
          target_id TEXT,
          original_payload_json TEXT,
          created_at TEXT NOT NULL,
          target_revision INTEGER CHECK(target_revision IS NULL OR target_revision > 0),
          UNIQUE(project_id, source_id, legacy_id, source_path)
        );
        INSERT INTO knowledge_import_sources_v24 SELECT * FROM knowledge_import_sources;
        DROP TABLE knowledge_import_sources;
        ALTER TABLE knowledge_import_sources_v24 RENAME TO knowledge_import_sources;
        CREATE INDEX knowledge_import_sources_project ON knowledge_import_sources(project_id, source_path, id);
      `);
      recordMigration(database, 24);
    })();
  }

  if (!hasMigration(database, 25)) {
    // Rebuilding the parent of many foreign keys requires enforcement off outside the transaction.
    database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        rebuildTable(
          database,
          "remote_principals",
          "CHECK(kind IN ('owner', 'agent', 'worker'))",
          "CHECK(kind IN ('owner', 'agent', 'worker', 'installation'))",
        );
        rebuildTable(
          database,
          "knowledge_history",
          "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token'))",
          "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none'))",
        );
        database.prepare("INSERT OR IGNORE INTO remote_principals(id, kind, status) VALUES (?, 'installation', 'active')")
          .run(INSTALLATION_PRINCIPAL_ID);
        database.prepare(`
          INSERT OR IGNORE INTO controller_settings(key, value_json, updated_at)
          VALUES ('authentication', ?, ?)
        `).run(JSON.stringify({ mode: "legacy", token: null, generation: 0 }), new Date().toISOString());
        if ((database.pragma("foreign_key_check") as unknown[]).length) {
          throw new Error("Migration 25 would leave dangling principal references.");
        }
        recordMigration(database, 25);
      })();
    } finally {
      database.pragma("foreign_keys = ON");
    }
  }

}

/** Frozen copy of the installation principal ID so migration 25 never follows later code changes. */
const INSTALLATION_PRINCIPAL_ID = "installation";

/** Replaces one table constraint; skips tables already carrying it so repaired migration records can rerun safely. */
function rebuildTable(database: Database.Database, table: string, from: string, to: string): void {
  const current = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!current) throw new Error(`Missing table ${table}.`);
  if (current.sql.includes(to)) return;
  if (!current.sql.includes(from)) throw new Error(`Unexpected ${table} definition; refusing to rebuild it.`);
  const next = current.sql.replace(from, to);
  const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table) as Array<{ sql: string }>;
  const replacement = `${table}_rebuild`;
  database.exec(next.replace(/^CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE ${replacement}`));
  database.exec(`
    INSERT INTO ${replacement} SELECT * FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${replacement} RENAME TO ${table};
  `);
  for (const index of indexes) database.exec(index.sql);
}

function ensureLaunchPresetColumn(database: Database.Database): void {
  const columns = new Set((database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(({ name }) => name));
  if (!columns.has("launch_preset")) {
    database.exec("ALTER TABLE projects ADD COLUMN launch_preset TEXT NOT NULL DEFAULT 'auto' CHECK(launch_preset IN ('auto', 'node', 'django'))");
  }
}

function hasMigration(database: Database.Database, version: number): boolean {
  return Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
}

function recordMigration(database: Database.Database, version: number): void {
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(version, new Date().toISOString());
}
