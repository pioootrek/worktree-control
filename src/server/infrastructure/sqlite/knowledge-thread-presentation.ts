import { createHash } from "node:crypto";

const MAX_SOURCE_BYTES = 131072;

function sourcePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_SOURCE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function importedTaskTopic(value: unknown, legacyId: unknown, sourcePath: unknown): string | null {
  const payload = sourcePayload(value);
  if (!payload) return null;
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim()
    : typeof legacyId === "string" && legacyId ? legacyId : sourcePath;
  return typeof title === "string" && title.length <= 200 && title.trim() ? title : null;
}

export function importedTaskPreview(value: unknown): string {
  const payload = sourcePayload(value);
  if (!payload) return "";
  for (const field of ["problem", "scope", "validation"] as const) {
    const entry = payload[field];
    const text = Array.isArray(entry) ? entry.filter((part): part is string => typeof part === "string").join(" ") : "";
    if (text.trim()) return compactPreview(text);
  }
  return "";
}

export function compactPreview(value: string): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 180 ? `${text.slice(0, 179).trimEnd()}…` : text;
}

export function importedRecordId(projectId: unknown, sourceId: unknown, sourcePath: unknown, kind: unknown): string {
  return createHash("sha256").update(`${projectId}\0${sourceId}\0${sourcePath}\0${kind}`).digest("hex").slice(0, 32);
}

// The importer has no direct thread provenance. Every condition here must hold
// before a historical task's topic may stand in for the generated thread title.
export function verifiedThreadSourceSql(singleThread: boolean): string { return `
  SELECT t.id thread_id, max(knowledge_import_topic(s.original_payload_json, s.legacy_id, s.source_path)) display_title,
    max(knowledge_import_preview(s.original_payload_json)) source_preview
  FROM knowledge_threads t
  JOIN knowledge_import_sources s ON s.project_id=t.project_id
    AND s.source_path=substr(t.body,length('Historical comments imported from ')+1)
    AND s.target_kind='task'
    AND s.mapping_version=2 AND s.legacy_id IS NOT NULL AND s.legacy_id<>''
    AND s.target_id=knowledge_import_record_id(t.project_id,s.source_id,s.source_path,'task')
    AND t.id=knowledge_import_record_id(t.project_id,s.source_id,s.source_path,'thread')
  JOIN knowledge_tasks task ON task.project_id=t.project_id AND task.id=s.target_id
    AND s.target_revision IS NOT NULL AND task.revision>=s.target_revision
    AND task.title=knowledge_import_topic(s.original_payload_json,s.legacy_id,s.source_path)
  WHERE t.project_id=@projectId ${singleThread ? "AND t.id=@id" : ""}
    AND t.title='Imported discussion: ' || s.legacy_id
    AND t.body='Historical comments imported from ' || s.source_path
    AND (SELECT count(*) FROM knowledge_relations relation
      WHERE relation.id=knowledge_import_record_id(t.project_id,s.source_id,s.source_path,'task-thread')
        AND relation.project_id=t.project_id AND relation.type='derived_from'
        AND relation.source_kind='task' AND relation.source_id=task.id
        AND relation.target_kind='thread' AND relation.target_id=t.id)=1
    AND EXISTS (SELECT 1 FROM knowledge_import_sources reply_source
      JOIN knowledge_replies reply ON reply.id=reply_source.target_id
        AND reply.project_id=t.project_id AND reply.thread_id=t.id
      WHERE reply_source.project_id=t.project_id
        AND reply_source.source_path>=s.source_path || '#notes/'
        AND reply_source.source_path<s.source_path || '#notes0'
        AND reply_source.target_kind='historical_comment'
        AND reply_source.mapping_version=2 AND reply_source.target_revision=reply.revision
        AND reply.id=knowledge_import_record_id(t.project_id,reply_source.source_id,reply_source.source_path,'reply')
        AND reply_source.source_id=s.source_id
        AND reply_source.source_repository=s.source_repository
        AND reply_source.source_commit=s.source_commit
        AND substr(reply_source.legacy_id,1,length(s.legacy_id)+6)=s.legacy_id || ':note:'
        AND substr(reply_source.source_path,1,length(s.source_path)+7)=s.source_path || '#notes/'
        AND substr(reply_source.legacy_id,length(s.legacy_id)+7)<>''
        AND substr(reply_source.source_path,length(s.source_path)+8)<>''
        AND substr(reply_source.legacy_id,length(s.legacy_id)+7)=substr(reply_source.source_path,length(s.source_path)+8)
        AND substr(reply_source.legacy_id,length(s.legacy_id)+7) NOT GLOB '*[^0-9]*'
        AND substr(reply_source.source_path,length(s.source_path)+8) NOT GLOB '*[^0-9]*')
  GROUP BY t.id HAVING count(*)=1`; }
