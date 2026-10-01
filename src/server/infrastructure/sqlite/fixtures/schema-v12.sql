-- Frozen schema 12 produced by migrations.ts at bfa6cff. No current store constructor.
CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
CREATE TABLE controller_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
CREATE TABLE controller_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE projects (
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
    test_environment_profiles_json TEXT NOT NULL DEFAULT '[{"name":"unit","policy":{"mode":"clean","serverProfile":null},"environment":{},"nodeEnv":"test","requiredVariables":[]},{"name":"tooling","policy":{"mode":"clean","serverProfile":null},"environment":{},"nodeEnv":null,"requiredVariables":[]}]',
    test_preset_profiles_json TEXT NOT NULL DEFAULT '{}',
    healthcheck_path TEXT NOT NULL,
    startup_timeout_ms INTEGER NOT NULL,
    selected_worktree_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE reservations (
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
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
CREATE TABLE test_runs (
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
CREATE TABLE worktree_storage_samples (
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
CREATE UNIQUE INDEX active_agent_idempotency_key
        ON reservations(owner, idempotency_key)
        WHERE kind = 'agent' AND released_at IS NULL AND idempotency_key IS NOT NULL
      ;
CREATE UNIQUE INDEX one_active_reservation_per_project
    ON reservations(project_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX test_runs_actor_idempotency
    ON test_runs(actor, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX test_runs_phase_queue ON test_runs(phase, queued_at, id);
CREATE INDEX test_runs_project_history ON test_runs(project_id, queued_at DESC);
CREATE INDEX worktree_storage_history
          ON worktree_storage_samples(project_id, worktree_path, measured_at);
INSERT INTO schema_migrations (version,applied_at) VALUES (1,'2026-10-01T09:52:11.612Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (2,'2026-10-01T09:52:11.613Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (3,'2026-10-01T09:52:11.613Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (4,'2026-10-01T09:52:11.614Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (5,'2026-10-01T09:52:11.614Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (6,'2026-10-01T09:52:11.614Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (7,'2026-10-01T09:52:11.614Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (8,'2026-10-01T09:52:11.614Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (9,'2026-10-01T09:52:11.614Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (10,'2026-10-01T09:52:11.615Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (11,'2026-10-01T09:52:11.615Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (12,'2026-10-01T09:52:11.615Z');
INSERT INTO controller_settings (key,value_json,updated_at) VALUES ('server_capacity','{"enabled":false,"limit":2}','2026-10-01T09:52:11.614Z');
INSERT INTO controller_settings (key,value_json,updated_at) VALUES ('test_queue','{"limit":1}','2026-10-01T09:52:11.615Z');
