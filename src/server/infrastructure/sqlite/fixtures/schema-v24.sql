-- Frozen schema 24 produced by migrations.ts at a727fd8. No current store constructor.
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
CREATE TABLE knowledge_attachments (
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
CREATE TABLE knowledge_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    record_kind TEXT NOT NULL CHECK(record_kind IN ('project', 'thread', 'reply', 'task', 'relation', 'memory')),
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('created', 'updated', 'archived', 'linked', 'unlinked', 'approved', 'superseded')),
    previous_json TEXT,
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    authentication_method TEXT NOT NULL CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL
  );
CREATE TABLE knowledge_idempotency (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(principal_id, project_id, operation, idempotency_key)
  );
CREATE TABLE knowledge_import_batches (
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
CREATE TABLE "knowledge_import_sources" (
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
CREATE TABLE knowledge_import_staging (
          batch_id TEXT NOT NULL REFERENCES knowledge_import_batches(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          mapping_json TEXT NOT NULL,
          PRIMARY KEY(batch_id, ordinal)
        );
CREATE TABLE knowledge_memories (
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
CREATE TABLE knowledge_project_grants (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    permissions_json TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(principal_id, project_id)
  );
CREATE TABLE knowledge_project_runtime_links (
    knowledge_project_id TEXT PRIMARY KEY REFERENCES knowledge_projects(id),
    runtime_project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE SET NULL,
    linked_at TEXT NOT NULL,
    unlinked_at TEXT
  );
CREATE TABLE knowledge_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE knowledge_relations (
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
CREATE TABLE knowledge_replies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    thread_id TEXT NOT NULL REFERENCES knowledge_threads(id),
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_by TEXT NOT NULL REFERENCES remote_principals(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE knowledge_tasks (
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
CREATE TABLE knowledge_threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_by TEXT NOT NULL REFERENCES remote_principals(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE TABLE principal_credentials (
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
CREATE TABLE remote_principal_project_grants (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id),
    project_id TEXT NOT NULL REFERENCES remote_project_identities(id),
    permissions_json TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(principal_id, project_id)
  );
CREATE TABLE remote_principals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('owner', 'agent', 'worker')),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))
  );
CREATE TABLE remote_project_identities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_remote TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))
  );
CREATE TABLE remote_verification_attempts (
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
CREATE TABLE remote_verification_requests (
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
CREATE TABLE remote_worker_project_grants (
    worker_id TEXT NOT NULL REFERENCES remote_workers(id),
    project_id TEXT NOT NULL REFERENCES remote_project_identities(id),
    local_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    preset_ids_json TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(worker_id, project_id)
  );
CREATE TABLE remote_workers (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE REFERENCES remote_principals(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    last_contact_at TEXT
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
CREATE INDEX knowledge_attachments_record ON knowledge_attachments(project_id, record_kind, record_id, created_at, id);
CREATE INDEX knowledge_history_record ON knowledge_history(project_id, record_kind, record_id, id);
CREATE INDEX knowledge_import_batches_target
          ON knowledge_import_batches(target_project_id, created_at, id);
CREATE INDEX knowledge_import_sources_project ON knowledge_import_sources(project_id, source_path, id);
CREATE INDEX knowledge_memories_project ON knowledge_memories(project_id, status, updated_at DESC, id);
CREATE INDEX knowledge_replies_thread ON knowledge_replies(project_id, thread_id, created_at, id);
CREATE INDEX knowledge_tasks_project ON knowledge_tasks(project_id, updated_at DESC, id);
CREATE INDEX knowledge_threads_project ON knowledge_threads(project_id, updated_at DESC, id);
CREATE UNIQUE INDEX one_active_reservation_per_project
    ON reservations(project_id) WHERE released_at IS NULL;
CREATE INDEX principal_credentials_principal
    ON principal_credentials(principal_id, created_at, id);
CREATE INDEX remote_verification_attempts_request
    ON remote_verification_attempts(request_id, sequence DESC);
CREATE INDEX remote_verification_requests_queue
    ON remote_verification_requests(phase, created_at, id);
CREATE UNIQUE INDEX test_runs_actor_idempotency
    ON test_runs(actor, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX test_runs_phase_queue ON test_runs(phase, queued_at, id);
CREATE INDEX test_runs_project_history ON test_runs(project_id, queued_at DESC);
CREATE INDEX worktree_launch_history ON audit_events(project_id, id DESC) WHERE event_type = 'worktree.launched';
CREATE INDEX worktree_storage_history
          ON worktree_storage_samples(project_id, worktree_path, measured_at);
INSERT INTO schema_migrations (version,applied_at) VALUES (1,'2026-10-01T09:52:11.617Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (2,'2026-10-01T09:52:11.618Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (3,'2026-10-01T09:52:11.618Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (4,'2026-10-01T09:52:11.618Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (5,'2026-10-01T09:52:11.618Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (6,'2026-10-01T09:52:11.619Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (7,'2026-10-01T09:52:11.619Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (8,'2026-10-01T09:52:11.619Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (9,'2026-10-01T09:52:11.619Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (10,'2026-10-01T09:52:11.619Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (11,'2026-10-01T09:52:11.619Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (12,'2026-10-01T09:52:11.620Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (13,'2026-10-01T09:52:11.620Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (14,'2026-10-01T09:52:11.620Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (15,'2026-10-01T09:52:11.620Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (16,'2026-10-01T09:52:11.620Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (17,'2026-10-01T09:52:11.620Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (18,'2026-10-01T09:52:11.621Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (19,'2026-10-01T09:52:11.621Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (20,'2026-10-01T09:52:11.622Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (21,'2026-10-01T09:52:11.622Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (22,'2026-10-01T09:52:11.623Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (23,'2026-10-01T09:52:11.623Z');
INSERT INTO schema_migrations (version,applied_at) VALUES (24,'2026-10-01T09:52:11.625Z');
INSERT INTO controller_settings (key,value_json,updated_at) VALUES ('server_capacity','{"enabled":false,"limit":2}','2026-10-01T09:52:11.618Z');
INSERT INTO controller_settings (key,value_json,updated_at) VALUES ('test_queue','{"limit":1}','2026-10-01T09:52:11.619Z');
