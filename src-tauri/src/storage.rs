use crate::attachments::{AttachmentSummary, ParsedAttachment};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: i64 = 9;
const DEFAULT_CONTEXT_SIZE: u32 = 4096;
const DEFAULT_OUTPUT_TOKEN_LIMIT: u32 = 2048;
const DEFAULT_REASONING_TOKEN_LIMIT: u32 = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub model: String,
    pub model_alias: String,
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub status: String,
    pub created_at: String,
    pub metrics: Option<Value>,
    pub attachments: Vec<AttachmentSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    pub conversation: ConversationSummary,
    pub messages: Vec<StoredMessage>,
    pub attachments: Vec<AttachmentSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub status: String,
    pub created_at: Option<String>,
    pub metrics: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub save_thinking: bool,
    pub default_mode: String,
    pub default_model: String,
    pub model_aliases: BTreeMap<String, String>,
    pub context_size: u32,
    pub output_token_limit: u32,
    pub reasoning_token_limit: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub filename: String,
    pub format: String,
    pub content: String,
}

pub fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建本地数据目录失败：{error}"))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("打开本地数据库失败：{error}"))?;
    migrate(&connection)?;
    Ok(connection)
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY,
               applied_at TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("初始化数据库迁移表失败：{error}"))?;

    let applied: Option<i64> = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("读取数据库版本失败：{error}"))?;

    if applied.unwrap_or(0) < 1 {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS conversations (
                   id TEXT PRIMARY KEY NOT NULL,
                   title TEXT NOT NULL,
                   model TEXT NOT NULL,
                   model_alias TEXT NOT NULL DEFAULT '',
                   mode TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                   id TEXT PRIMARY KEY NOT NULL,
                   conversation_id TEXT NOT NULL,
                   role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
                   content TEXT NOT NULL,
                   thinking TEXT,
                   status TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   metrics_json TEXT,
                   FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence ON messages(conversation_id, sequence);
                 CREATE TABLE IF NOT EXISTS settings (
                   key TEXT PRIMARY KEY NOT NULL,
                   value TEXT NOT NULL
                 );
                 INSERT OR IGNORE INTO settings(key, value) VALUES
                   ('theme', 'system'),
                   ('save_thinking', 'false'),
                   ('default_mode', 'fast'),
                   ('context_size', '4096'),
                   ('output_token_limit', '2048'),
                   ('reasoning_token_limit', '2048');",
            )
            .map_err(|error| format!("执行数据库迁移失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![1, timestamp()],
            )
            .map_err(|error| format!("记录数据库迁移版本失败：{error}"))?;
    }

    if applied.unwrap_or(0) < 2 {
        let has_model_alias: bool = connection
            .prepare("PRAGMA table_info(conversations)")
            .map_err(|error| format!("读取会话表结构失败：{error}"))?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("读取会话字段失败：{error}"))?
            .filter_map(Result::ok)
            .any(|name| name == "model_alias");
        if !has_model_alias {
            connection
                .execute(
                    "ALTER TABLE conversations ADD COLUMN model_alias TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(|error| format!("升级会话模型别名字段失败：{error}"))?;
        }
        connection
            .execute_batch(
                "INSERT OR IGNORE INTO settings(key, value) VALUES
                   ('default_model', ''),
                   ('model_alias', '');",
            )
            .map_err(|error| format!("补充模型设置失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![2, timestamp()],
            )
            .map_err(|error| format!("记录数据库迁移版本失败：{error}"))?;
    }

    if applied.unwrap_or(0) < 3 {
        let legacy_default_model: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'default_model'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取旧模型设置失败：{error}"))?;
        let legacy_alias: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'model_alias'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取旧模型别名失败：{error}"))?;
        let mut aliases = BTreeMap::new();
        if let (Some(model), Some(alias)) = (legacy_default_model, legacy_alias) {
            let model = model.trim().to_string();
            let alias: String = alias.trim().chars().take(80).collect();
            if !model.is_empty() && !alias.is_empty() {
                aliases.insert(model, alias);
            }
        }
        let aliases_json = serde_json::to_string(&aliases)
            .map_err(|error| format!("迁移模型别名失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES ('model_aliases', ?1)",
                params![aliases_json],
            )
            .map_err(|error| format!("补充模型别名设置失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![3, timestamp()],
            )
            .map_err(|error| format!("记录数据库迁移版本失败：{error}"))?;
    }

    if applied.unwrap_or(0) < 4 {
        let legacy_ids: Vec<String> = {
            let mut statement = connection
                .prepare(
                    "SELECT id FROM conversations
                     WHERE title = '新对话'
                     ORDER BY created_at ASC, id ASC",
                )
                .map_err(|error| format!("准备旧会话名称查询失败：{error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("读取旧会话名称失败：{error}"))?;
            rows.map(|row| row.map_err(|error| format!("读取旧会话名称失败：{error}")))
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in legacy_ids {
            let title = next_conversation_title(connection)?;
            connection
                .execute(
                    "UPDATE conversations SET title = ?1 WHERE id = ?2",
                    params![title, id],
                )
                .map_err(|error| format!("更新旧会话名称失败：{error}"))?;
        }
        connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![4, timestamp()],
            )
            .map_err(|error| format!("记录数据库迁移版本失败：{error}"))?;
    }

    if applied.unwrap_or(0) < SCHEMA_VERSION {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS conversation_attachments (
                   id TEXT PRIMARY KEY NOT NULL,
                   conversation_id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   kind TEXT NOT NULL,
                   size_bytes INTEGER NOT NULL,
                   text_characters INTEGER NOT NULL,
                   chunk_count INTEGER NOT NULL,
                   page_count INTEGER,
                   message_id TEXT,
                   sheets_json TEXT NOT NULL,
                   warnings_json TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_conversation_attachments_conversation
                   ON conversation_attachments(conversation_id, created_at ASC);",
            )
            .map_err(|error| format!("创建会话附件表失败：{error}"))?;
        let has_message_id: bool = connection
            .prepare("PRAGMA table_info(conversation_attachments)")
            .map_err(|error| format!("读取会话附件表结构失败：{error}"))?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("读取会话附件字段失败：{error}"))?
            .filter_map(Result::ok)
            .any(|name| name == "message_id");
        if !has_message_id {
            connection
                .execute(
                    "ALTER TABLE conversation_attachments ADD COLUMN message_id TEXT",
                    [],
                )
                .map_err(|error| format!("升级会话附件消息关联字段失败：{error}"))?;
        }
        connection
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_conversation_attachments_message
                 ON conversation_attachments(message_id, created_at ASC)",
                [],
            )
            .map_err(|error| format!("创建附件消息索引失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES ('context_size', ?1)",
                params![DEFAULT_CONTEXT_SIZE.to_string()],
            )
            .map_err(|error| format!("补充上下文大小设置失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES ('output_token_limit', ?1)",
                params![DEFAULT_OUTPUT_TOKEN_LIMIT.to_string()],
            )
            .map_err(|error| format!("补充输出消息 token 上限设置失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES ('reasoning_token_limit', ?1)",
                params![DEFAULT_REASONING_TOKEN_LIMIT.to_string()],
            )
            .map_err(|error| format!("补充推理输出 token 上限设置失败：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![SCHEMA_VERSION, timestamp()],
            )
            .map_err(|error| format!("记录数据库迁移版本失败：{error}"))?;
    }

    Ok(())
}

pub fn list_conversations(
    connection: &Connection,
    query: Option<&str>,
) -> Result<Vec<ConversationSummary>, String> {
    let search = format!("%{}%", query.unwrap_or("").trim());
    let mut statement = connection
        .prepare(
            "SELECT c.id, c.title, c.model, c.model_alias, c.mode, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
             FROM conversations c
             WHERE LOWER(c.title) LIKE LOWER(?1)
                OR LOWER(c.model) LIKE LOWER(?1)
                OR LOWER(c.model_alias) LIKE LOWER(?1)
                OR EXISTS (
                  SELECT 1 FROM messages sm
                  WHERE sm.conversation_id = c.id AND LOWER(sm.content) LIKE LOWER(?1)
                )
             ORDER BY c.updated_at DESC",
        )
        .map_err(|error| format!("准备会话列表查询失败：{error}"))?;
    let rows = statement
        .query_map(params![search], |row| {
            let model: String = row.get(2)?;
            let model_alias: String = row.get(3)?;
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                model: model.clone(),
                model_alias: if model_alias.trim().is_empty() {
                    model
                } else {
                    model_alias
                },
                mode: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                message_count: row.get::<_, i64>(7)? as u32,
            })
        })
        .map_err(|error| format!("读取会话列表失败：{error}"))?;

    rows.map(|row| row.map_err(|error| format!("读取会话记录失败：{error}")))
        .collect()
}

fn insert_conversation(
    connection: &Connection,
    id: &str,
    model: &str,
    model_alias: Option<&str>,
    mode: &str,
    title: Option<&str>,
) -> Result<String, String> {
    let id = required(id, "会话 ID")?;
    let model = required(model, "模型名称")?;
    let model_alias = normalize_model_alias(model_alias.unwrap_or(""), &model);
    let mode = required(mode, "性能模式")?;
    validate_mode(&mode)?;
    let now = timestamp();
    let title = match title {
        Some(value) => normalize_title(value),
        None => next_conversation_title(connection)?,
    };
    connection
        .execute(
            "INSERT OR IGNORE INTO conversations(id, title, model, model_alias, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, title, model, model_alias, mode, now],
        )
        .map_err(|error| format!("创建会话失败：{error}"))?;
    Ok(id)
}

pub fn create_conversation_with_alias(
    connection: &Connection,
    id: &str,
    model: &str,
    model_alias: Option<&str>,
    mode: &str,
    title: Option<&str>,
) -> Result<ConversationDetail, String> {
    let id = insert_conversation(connection, id, model, model_alias, mode, title)?;
    get_conversation(connection, &id)
}

pub fn get_conversation(connection: &Connection, id: &str) -> Result<ConversationDetail, String> {
    let id = required(id, "会话 ID")?;
    let conversation = connection
        .query_row(
            "SELECT c.id, c.title, c.model, c.model_alias, c.mode, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
             FROM conversations c WHERE c.id = ?1",
            params![id],
            |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    model: row.get(2)?,
                    model_alias: {
                        let alias: String = row.get(3)?;
                        if alias.trim().is_empty() {
                            row.get(2)?
                        } else {
                            alias
                        }
                    },
                    mode: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    message_count: row.get::<_, i64>(7)? as u32,
                })
            },
        )
        .optional()
        .map_err(|error| format!("读取会话失败：{error}"))?
        .ok_or_else(|| "会话不存在".to_string())?;

    let mut statement = connection
        .prepare(
            "SELECT id, conversation_id, role, content, thinking, status, created_at, metrics_json
             FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC, created_at ASC",
        )
        .map_err(|error| format!("准备消息查询失败：{error}"))?;
    let rows = statement
        .query_map(params![id], |row| {
            let metrics_json: Option<String> = row.get(7)?;
            Ok(StoredMessage {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                thinking: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
                metrics: metrics_json.and_then(|value| serde_json::from_str(&value).ok()),
                attachments: Vec::new(),
            })
        })
        .map_err(|error| format!("读取消息失败：{error}"))?;
    let messages = rows
        .map(|row| row.map_err(|error| format!("读取消息记录失败：{error}")))
        .collect::<Result<Vec<_>, _>>()?;
    let attachment_records = list_conversation_attachment_records(connection, &id)?;
    let attachments = attachment_records
        .iter()
        .map(|(_, attachment)| attachment.clone())
        .collect::<Vec<_>>();
    let mut messages = messages;
    for message in &mut messages {
        message.attachments = attachment_records
            .iter()
            .filter(|(message_id, _)| message_id.as_deref() == Some(message.id.as_str()))
            .map(|(_, attachment)| attachment.clone())
            .collect();
    }
    Ok(ConversationDetail {
        conversation,
        messages,
        attachments,
    })
}

fn list_conversation_attachments(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<AttachmentSummary>, String> {
    Ok(
        list_conversation_attachment_records(connection, conversation_id)?
            .into_iter()
            .map(|(_, attachment)| attachment)
            .collect(),
    )
}

fn list_conversation_attachment_records(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<(Option<String>, AttachmentSummary)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, message_id, name, kind, size_bytes, text_characters, chunk_count, page_count,
                    sheets_json, warnings_json
             FROM conversation_attachments
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|error| format!("准备会话附件查询失败：{error}"))?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            let sheets_json: String = row.get(8)?;
            let warnings_json: String = row.get(9)?;
            Ok((
                row.get(1)?,
                AttachmentSummary {
                    id: row.get(0)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    size_bytes: row.get::<_, i64>(4)? as u64,
                    text_characters: row.get::<_, i64>(5)? as usize,
                    chunk_count: row.get::<_, i64>(6)? as usize,
                    page_count: row.get::<_, Option<i64>>(7)?.map(|value| value as usize),
                    sheets: serde_json::from_str(&sheets_json).unwrap_or_default(),
                    warnings: serde_json::from_str(&warnings_json).unwrap_or_default(),
                },
            ))
        })
        .map_err(|error| format!("读取会话附件失败：{error}"))?;
    rows.map(|row| row.map_err(|error| format!("读取会话附件记录失败：{error}")))
        .collect()
}

pub fn save_conversation_attachments(
    connection: &Connection,
    conversation_id: &str,
    message_id: &str,
    attachments: &[ParsedAttachment],
) -> Result<(), String> {
    let conversation_id = required(conversation_id, "会话 ID")?;
    let message_id = required(message_id, "消息 ID")?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conversations WHERE id = ?1)",
            params![conversation_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("确认会话附件归属失败：{error}"))?;
    if !exists {
        return Err("会话不存在，无法保存附件".to_string());
    }
    let message_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2)",
            params![message_id, conversation_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("确认附件消息归属失败：{error}"))?;
    if !message_exists {
        return Err("消息不存在或不属于当前会话，无法保存附件".to_string());
    }
    for attachment in attachments {
        let summary = &attachment.summary;
        let sheets_json = serde_json::to_string(&summary.sheets)
            .map_err(|error| format!("序列化附件工作表摘要失败：{error}"))?;
        let warnings_json = serde_json::to_string(&summary.warnings)
            .map_err(|error| format!("序列化附件提示失败：{error}"))?;
        let payload_json = serde_json::to_string(attachment)
            .map_err(|error| format!("序列化本地附件内容失败：{error}"))?;
        connection
            .execute(
                "INSERT INTO conversation_attachments(
                   id, conversation_id, name, kind, size_bytes, text_characters, chunk_count,
                   page_count, message_id, sheets_json, warnings_json, payload_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name, kind = excluded.kind, size_bytes = excluded.size_bytes,
                   text_characters = excluded.text_characters, chunk_count = excluded.chunk_count,
                   page_count = excluded.page_count, message_id = excluded.message_id,
                   sheets_json = excluded.sheets_json,
                   warnings_json = excluded.warnings_json, payload_json = excluded.payload_json
                 WHERE conversation_attachments.conversation_id = excluded.conversation_id",
                params![
                    summary.id,
                    conversation_id,
                    summary.name,
                    summary.kind,
                    summary.size_bytes as i64,
                    summary.text_characters as i64,
                    summary.chunk_count as i64,
                    summary.page_count.map(|value| value as i64),
                    message_id,
                    sheets_json,
                    warnings_json,
                    payload_json,
                    timestamp(),
                ],
            )
            .map_err(|error| format!("保存本地附件失败：{error}"))?;
    }
    Ok(())
}

pub fn existing_attachment_ids(
    connection: &Connection,
    conversation_id: &str,
    attachment_ids: &[String],
) -> Result<Vec<String>, String> {
    let summaries = list_conversation_attachments(connection, conversation_id)?;
    Ok(attachment_ids
        .iter()
        .filter(|id| {
            summaries
                .iter()
                .any(|attachment| attachment.id == id.as_str())
        })
        .cloned()
        .collect())
}

pub fn load_attachment_payloads(
    connection: &Connection,
    conversation_id: &str,
    attachment_ids: &[String],
) -> Result<Vec<ParsedAttachment>, String> {
    let summaries = list_conversation_attachments(connection, conversation_id)?;
    if attachment_ids
        .iter()
        .any(|id| !summaries.iter().any(|attachment| attachment.id == *id))
    {
        return Err("部分附件已不可用，请重新添加后再发送".to_string());
    }
    let mut statement = connection
        .prepare("SELECT id, payload_json FROM conversation_attachments WHERE conversation_id = ?1")
        .map_err(|error| format!("准备附件正文查询失败：{error}"))?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("读取附件正文失败：{error}"))?;
    let mut parsed = std::collections::BTreeMap::new();
    for row in rows {
        let (id, payload) = row.map_err(|error| format!("读取附件正文记录失败：{error}"))?;
        let attachment = serde_json::from_str::<ParsedAttachment>(&payload)
            .map_err(|error| format!("读取已保存的附件内容失败：{error}"))?;
        parsed.insert(id, attachment);
    }
    attachment_ids
        .iter()
        .map(|id| {
            parsed
                .remove(id)
                .ok_or_else(|| "部分附件已不可用，请重新添加后再发送".to_string())
        })
        .collect()
}

pub fn remove_conversation_attachment(
    connection: &Connection,
    conversation_id: &str,
    attachment_id: &str,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "DELETE FROM conversation_attachments WHERE conversation_id = ?1 AND id = ?2",
            params![
                required(conversation_id, "会话 ID")?,
                required(attachment_id, "附件 ID")?
            ],
        )
        .map_err(|error| format!("移除会话附件失败：{error}"))?;
    if changed == 0 {
        return Err("附件不存在或已经移除".to_string());
    }
    Ok(())
}

pub fn rename_conversation(
    connection: &Connection,
    id: &str,
    title: &str,
) -> Result<ConversationSummary, String> {
    let id = required(id, "会话 ID")?;
    let title = normalize_title(&required(title, "会话名称")?);
    let changed = connection
        .execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, timestamp(), id],
        )
        .map_err(|error| format!("重命名会话失败：{error}"))?;
    if changed == 0 {
        return Err("会话不存在".to_string());
    }
    get_conversation(connection, &id).map(|detail| detail.conversation)
}

pub fn delete_conversation(connection: &Connection, id: &str) -> Result<(), String> {
    let id = required(id, "会话 ID")?;
    connection
        .execute("DELETE FROM conversations WHERE id = ?1", params![id])
        .map_err(|error| format!("删除会话失败：{error}"))?;
    Ok(())
}

fn save_message_inner(connection: &Connection, input: MessageInput) -> Result<(), String> {
    validate_role(&input.role)?;
    let status = required(&input.status, "消息状态")?;
    let content = input.content;
    let thinking = if setting_bool(connection, "save_thinking")? {
        input.thinking.filter(|value| !value.is_empty())
    } else {
        None
    };
    let metrics_json = input
        .metrics
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("序列化消息指标失败：{error}"))?;
    let sequence: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM messages WHERE conversation_id = ?1",
            params![input.conversation_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取消息顺序失败：{error}"))?;
    let created_at = input.created_at.unwrap_or_else(timestamp);
    connection
        .execute(
            "INSERT INTO messages(id, conversation_id, role, content, thinking, status, created_at, sequence, metrics_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET content = excluded.content,
               thinking = excluded.thinking, status = excluded.status, metrics_json = excluded.metrics_json",
            params![
                input.id,
                input.conversation_id,
                input.role,
                content,
                thinking,
                status,
                created_at,
                sequence,
                metrics_json
            ],
        )
        .map_err(|error| format!("保存消息失败：{error}"))?;
    connection
        .execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![timestamp(), input.conversation_id],
        )
        .map_err(|error| format!("更新会话时间失败：{error}"))?;
    Ok(())
}

pub fn save_message(connection: &Connection, input: MessageInput) -> Result<(), String> {
    save_message_inner(connection, input)
}

pub fn create_conversation_with_message_alias(
    connection: &mut Connection,
    id: &str,
    model: &str,
    model_alias: Option<&str>,
    mode: &str,
    title: Option<&str>,
    message: MessageInput,
) -> Result<ConversationDetail, String> {
    let conversation_id = required(id, "会话 ID")?;
    if message.conversation_id.trim() != conversation_id {
        return Err("消息所属会话与会话 ID 不一致".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启会话事务失败：{error}"))?;
    insert_conversation(
        &transaction,
        &conversation_id,
        model,
        model_alias,
        mode,
        title,
    )?;
    save_message_inner(&transaction, message)?;
    transaction
        .commit()
        .map_err(|error| format!("提交会话事务失败：{error}"))?;
    get_conversation(connection, &conversation_id)
}

pub fn get_settings(connection: &Connection) -> Result<AppSettings, String> {
    let mut settings = AppSettings {
        theme: "system".to_string(),
        save_thinking: false,
        default_mode: "fast".to_string(),
        default_model: String::new(),
        model_aliases: BTreeMap::new(),
        context_size: DEFAULT_CONTEXT_SIZE,
        output_token_limit: DEFAULT_OUTPUT_TOKEN_LIMIT,
        reasoning_token_limit: DEFAULT_REASONING_TOKEN_LIMIT,
    };
    let mut statement = connection
        .prepare("SELECT key, value FROM settings")
        .map_err(|error| format!("准备设置查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("读取设置失败：{error}"))?;
    for row in rows {
        let (key, value) = row.map_err(|error| format!("读取设置项失败：{error}"))?;
        match key.as_str() {
            "theme" => settings.theme = value,
            "save_thinking" => settings.save_thinking = value == "true",
            "default_mode" => settings.default_mode = value,
            "default_model" => settings.default_model = value,
            "model_aliases" => {
                settings.model_aliases = serde_json::from_str(&value).unwrap_or_default();
            }
            "context_size" => {
                settings.context_size = match value.parse::<u32>() {
                    Ok(value) if matches!(value, 4096 | 8192 | 16384) => value,
                    _ => DEFAULT_CONTEXT_SIZE,
                };
            }
            "output_token_limit" => {
                settings.output_token_limit = match value.parse::<u32>() {
                    Ok(value) if matches!(value, 1024 | 2048 | 4096) => value,
                    _ => DEFAULT_OUTPUT_TOKEN_LIMIT,
                };
            }
            "reasoning_token_limit" => {
                settings.reasoning_token_limit = match value.parse::<u32>() {
                    Ok(value) if matches!(value, 0 | 2048 | 4096 | 8192) => value,
                    _ => DEFAULT_REASONING_TOKEN_LIMIT,
                };
            }
            _ => {}
        }
    }
    Ok(settings)
}

pub fn update_settings(
    connection: &Connection,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark") {
        return Err("不支持的主题设置".to_string());
    }
    if !matches!(
        settings.default_mode.as_str(),
        "fast" | "balanced" | "reasoning"
    ) {
        return Err("不支持的默认性能模式".to_string());
    }
    if !matches!(settings.context_size, 4096 | 8192 | 16384) {
        return Err("不支持的上下文大小，可选 4K、8K 或 16K".to_string());
    }
    if !matches!(settings.output_token_limit, 1024 | 2048 | 4096) {
        return Err("不支持的输出消息 token 上限，可选 1K、2K 或 4K".to_string());
    }
    if !matches!(settings.reasoning_token_limit, 0 | 2048 | 4096 | 8192) {
        return Err("不支持的推理输出 token 上限，可选 2K、4K、8K 或不限".to_string());
    }
    settings.default_model = settings.default_model.trim().to_string();
    settings.model_aliases = settings
        .model_aliases
        .into_iter()
        .filter_map(|(model, alias)| {
            let model = model.trim().to_string();
            if model.is_empty() {
                return None;
            }
            let alias = alias.trim().chars().take(80).collect();
            Some((model, alias))
        })
        .collect();
    let model_aliases = serde_json::to_string(&settings.model_aliases)
        .map_err(|error| format!("序列化模型别名失败：{error}"))?;
    for (key, value) in [
        ("theme", settings.theme.clone()),
        ("save_thinking", settings.save_thinking.to_string()),
        ("default_mode", settings.default_mode.clone()),
        ("default_model", settings.default_model.clone()),
        ("model_aliases", model_aliases),
        ("context_size", settings.context_size.to_string()),
        (
            "output_token_limit",
            settings.output_token_limit.to_string(),
        ),
        (
            "reasoning_token_limit",
            settings.reasoning_token_limit.to_string(),
        ),
        // Keep the legacy key empty so an older client cannot accidentally
        // display a stale single-model alias after this migration.
        ("model_alias", String::new()),
    ] {
        connection
            .execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|error| format!("保存设置失败：{error}"))?;
    }
    get_settings(connection)
}

pub fn clear_conversations(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM conversations", [])
        .map_err(|error| format!("清空本地会话失败：{error}"))?;
    Ok(())
}

pub fn export_conversation(
    connection: &Connection,
    id: &str,
    format: &str,
) -> Result<ExportPayload, String> {
    let detail = get_conversation(connection, id)?;
    let title = sanitize_filename(&detail.conversation.title);
    match format {
        "markdown" => Ok(ExportPayload {
            filename: format!("{title}.md"),
            format: format.to_string(),
            content: export_markdown(&detail),
        }),
        "json" => Ok(ExportPayload {
            filename: format!("{title}.json"),
            format: format.to_string(),
            content: serde_json::to_string_pretty(&detail)
                .map_err(|error| format!("生成 JSON 导出失败：{error}"))?,
        }),
        _ => Err("不支持的导出格式".to_string()),
    }
}

fn export_markdown(detail: &ConversationDetail) -> String {
    let mut output = format!(
        "# {}\n\n- 模型：{}\n- 模式：{}\n- 更新时间：{}\n",
        detail.conversation.title,
        detail.conversation.model,
        detail.conversation.mode,
        detail.conversation.updated_at
    );
    if !detail.attachments.is_empty() {
        output.push_str("\n## 本地附件\n");
        for attachment in &detail.attachments {
            output.push_str(&format!(
                "\n- {}（{}，{} 个片段）",
                attachment.name, attachment.kind, attachment.chunk_count
            ));
        }
        output.push('\n');
    }
    for message in &detail.messages {
        let label = match message.role.as_str() {
            "user" => "你",
            "assistant" => "模型",
            _ => "系统",
        };
        output.push_str(&format!("\n## {label}\n\n{}\n", message.content));
        if let Some(thinking) = &message.thinking {
            if !thinking.is_empty() {
                output.push_str(&format!(
                    "\n<details><summary>思考内容</summary>\n\n{thinking}\n\n</details>\n"
                ));
            }
        }
    }
    output
}

fn setting_bool(connection: &Connection, key: &str) -> Result<bool, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取设置失败：{error}"))?;
    Ok(value.as_deref() == Some("true"))
}

fn required(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label}不能为空"))
    } else {
        Ok(value.to_string())
    }
}

fn validate_role(role: &str) -> Result<(), String> {
    if matches!(role, "system" | "user" | "assistant") {
        Ok(())
    } else {
        Err("不支持的消息角色".to_string())
    }
}

fn validate_mode(mode: &str) -> Result<(), String> {
    if matches!(mode, "fast" | "balanced" | "reasoning") {
        Ok(())
    } else {
        Err("不支持的性能模式".to_string())
    }
}

fn normalize_title(value: &str) -> String {
    let trimmed = value.trim();
    let mut title: String = trimmed.chars().take(80).collect();
    if title.is_empty() {
        title = "新对话".to_string();
    }
    title
}

fn next_conversation_title(connection: &Connection) -> Result<String, String> {
    let mut statement = connection
        .prepare("SELECT title FROM conversations WHERE title LIKE '会话%'")
        .map_err(|error| format!("准备会话名称查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("读取会话名称失败：{error}"))?;
    let mut max_number = 0_u64;
    for row in rows {
        let title = row.map_err(|error| format!("读取会话名称失败：{error}"))?;
        let Some(number) = title
            .strip_prefix("会话")
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        max_number = max_number.max(number);
    }
    Ok(format!("会话{}", max_number.saturating_add(1)))
}

fn normalize_model_alias(value: &str, model: &str) -> String {
    let alias: String = value.trim().chars().take(80).collect();
    if alias.is_empty() {
        model.to_string()
    } else {
        alias
    }
}

fn sanitize_filename(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .take(60)
        .collect();
    if sanitized.trim().is_empty() {
        "ollmin-conversation".to_string()
    } else {
        sanitized
    }
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        clear_conversations, create_conversation_with_alias,
        create_conversation_with_message_alias, get_conversation, get_settings, list_conversations,
        load_attachment_payloads, migrate, remove_conversation_attachment, rename_conversation,
        save_conversation_attachments, save_message, update_settings, AppSettings, MessageInput,
    };
    use crate::attachments::ParsedAttachment;
    use rusqlite::Connection;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        migrate(&connection).expect("migrate");
        connection
    }

    fn message(id: &str, conversation_id: &str, thinking: Option<&str>) -> MessageInput {
        MessageInput {
            id: id.to_string(),
            conversation_id: conversation_id.to_string(),
            role: "assistant".to_string(),
            content: "answer".to_string(),
            thinking: thinking.map(str::to_string),
            status: "done".to_string(),
            created_at: None,
            metrics: Some(json!({"outputTokens": 2})),
        }
    }

    fn attachment() -> ParsedAttachment {
        serde_json::from_value(json!({
            "id": "attachment-a",
            "name": "资料.pdf",
            "kind": "PDF",
            "sizeBytes": 42,
            "textCharacters": 12,
            "chunkCount": 1,
            "pageCount": 1,
            "sheets": [],
            "warnings": [],
            "chunks": [{ "content": "第 1 页：会务保障安排" }]
        }))
        .expect("attachment fixture")
    }

    #[test]
    fn migration_is_idempotent_and_defaults_are_available() {
        let connection = database();
        migrate(&connection).expect("second migration");
        let settings = get_settings(&connection).expect("settings");
        assert_eq!(settings.theme, "system");
        assert!(!settings.save_thinking);
        assert_eq!(settings.default_mode, "fast");
        assert!(settings.default_model.is_empty());
        assert!(settings.model_aliases.is_empty());
        assert_eq!(settings.context_size, 4096);
        assert_eq!(settings.output_token_limit, 2048);
        assert_eq!(settings.reasoning_token_limit, 2048);
        let aliases: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'model_aliases'",
                [],
                |row| row.get(0),
            )
            .expect("model aliases setting");
        assert_eq!(aliases, "{}");
    }

    #[test]
    fn migration_upgrades_an_existing_v1_conversation_table() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (1, '0');
                 CREATE TABLE conversations (
                   id TEXT PRIMARY KEY NOT NULL,
                   title TEXT NOT NULL,
                   model TEXT NOT NULL,
                   mode TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
            )
            .expect("create v1 schema");

        migrate(&connection).expect("upgrade v1 schema");
        let has_alias: bool = connection
            .prepare("PRAGMA table_info(conversations)")
            .expect("inspect schema")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("read schema")
            .filter_map(Result::ok)
            .any(|name| name == "model_alias");
        assert!(has_alias);
        assert!(get_settings(&connection)
            .expect("settings after upgrade")
            .default_model
            .is_empty());
        assert_eq!(
            get_settings(&connection)
                .expect("output limit after upgrade")
                .output_token_limit,
            2048
        );
    }

    #[test]
    fn migration_adds_message_id_to_existing_attachment_table() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (8, '0');
                 CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                 CREATE TABLE conversation_attachments (
                   id TEXT PRIMARY KEY NOT NULL,
                   conversation_id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   kind TEXT NOT NULL,
                   size_bytes INTEGER NOT NULL,
                   text_characters INTEGER NOT NULL,
                   chunk_count INTEGER NOT NULL,
                   page_count INTEGER,
                   sheets_json TEXT NOT NULL,
                   warnings_json TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );",
            )
            .expect("create v8 attachment schema");

        migrate(&connection).expect("upgrade v8 attachment schema");
        let has_message_id: bool = connection
            .prepare("PRAGMA table_info(conversation_attachments)")
            .expect("inspect schema")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("read schema")
            .filter_map(Result::ok)
            .any(|name| name == "message_id");
        assert!(has_message_id);
    }

    #[test]
    fn messages_cascade_when_conversation_is_deleted() {
        let connection = database();
        create_conversation_with_alias(
            &connection,
            "conversation-a",
            "qwen3:4b",
            None,
            "fast",
            None,
        )
        .expect("create");
        save_message(
            &connection,
            message("message-a", "conversation-a", Some("private")),
        )
        .expect("save");
        save_conversation_attachments(&connection, "conversation-a", "message-a", &[attachment()])
            .expect("save attachment");
        clear_conversations(&connection).expect("clear");
        assert!(get_conversation(&connection, "conversation-a").is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0);
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM conversation_attachments", [], |row| {
                row.get(0)
            })
            .expect("attachment count");
        assert_eq!(attachment_count, 0);
    }

    #[test]
    fn attachments_are_restored_and_removed_with_their_conversation() {
        let connection = database();
        create_conversation_with_alias(
            &connection,
            "conversation-attachment",
            "qwen3:4b",
            None,
            "fast",
            None,
        )
        .expect("create");
        save_message(
            &connection,
            message("message-attachment", "conversation-attachment", None),
        )
        .expect("save message");
        save_conversation_attachments(
            &connection,
            "conversation-attachment",
            "message-attachment",
            &[attachment()],
        )
        .expect("save attachment");
        let detail = get_conversation(&connection, "conversation-attachment").expect("read");
        assert_eq!(detail.attachments.len(), 1);
        assert_eq!(detail.attachments[0].name, "资料.pdf");
        assert_eq!(detail.messages[0].attachments[0].name, "资料.pdf");
        assert_eq!(
            load_attachment_payloads(
                &connection,
                "conversation-attachment",
                &["attachment-a".to_string()],
            )
            .expect("load attachment")
            .len(),
            1
        );
        remove_conversation_attachment(&connection, "conversation-attachment", "attachment-a")
            .expect("remove attachment");
        assert!(get_conversation(&connection, "conversation-attachment")
            .expect("read after remove")
            .attachments
            .is_empty());
    }

    #[test]
    fn thinking_is_not_persisted_until_setting_is_enabled() {
        let connection = database();
        create_conversation_with_alias(
            &connection,
            "conversation-b",
            "qwen3:4b",
            None,
            "fast",
            None,
        )
        .expect("create");
        save_message(
            &connection,
            message("message-b", "conversation-b", Some("private")),
        )
        .expect("save");
        assert!(get_conversation(&connection, "conversation-b")
            .expect("read")
            .messages[0]
            .thinking
            .is_none());
        update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: true,
                default_mode: "fast".to_string(),
                default_model: "qwen3:4b".to_string(),
                model_aliases: BTreeMap::from([(
                    String::from("qwen3:4b"),
                    String::from("本地助手"),
                )]),
                context_size: 8192,
                output_token_limit: 2048,
                reasoning_token_limit: 2048,
            },
        )
        .expect("settings");
        save_message(
            &connection,
            message("message-c", "conversation-b", Some("kept")),
        )
        .expect("save");
        assert_eq!(
            get_conversation(&connection, "conversation-b")
                .expect("read")
                .messages[1]
                .thinking
                .as_deref(),
            Some("kept")
        );
    }

    #[test]
    fn search_and_rename_update_conversation_metadata() {
        let connection = database();
        create_conversation_with_alias(
            &connection,
            "conversation-c",
            "qwen3:4b",
            Some("本地助手"),
            "fast",
            None,
        )
        .expect("create");
        save_message(&connection, message("message-d", "conversation-c", None)).expect("save");
        rename_conversation(&connection, "conversation-c", "本地问答").expect("rename");
        let results = list_conversations(&connection, Some("本地")).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "本地问答");
        assert_eq!(
            list_conversations(&connection, Some("助手"))
                .expect("alias search")
                .len(),
            1
        );
    }

    #[test]
    fn conversation_and_first_message_are_created_atomically() {
        let mut connection = database();
        let detail = create_conversation_with_message_alias(
            &mut connection,
            "conversation-transaction",
            "qwen3:4b",
            None,
            "fast",
            None,
            MessageInput {
                id: "message-transaction".to_string(),
                conversation_id: "conversation-transaction".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                thinking: None,
                status: "done".to_string(),
                created_at: None,
                metrics: None,
            },
        )
        .expect("transaction");
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].content, "hello");
        assert_eq!(detail.conversation.message_count, 1);
    }

    #[test]
    fn conversation_transaction_rolls_back_when_message_is_invalid() {
        let mut connection = database();
        let mut invalid = message("message-invalid", "conversation-rollback", None);
        invalid.role = "tool".to_string();
        assert!(create_conversation_with_message_alias(
            &mut connection,
            "conversation-rollback",
            "qwen3:4b",
            None,
            "fast",
            None,
            invalid,
        )
        .is_err());
        assert!(get_conversation(&connection, "conversation-rollback").is_err());
    }

    #[test]
    fn model_alias_is_persisted_on_the_conversation_snapshot() {
        let connection = database();
        let detail = create_conversation_with_alias(
            &connection,
            "conversation-alias",
            "qwen3:4b",
            Some("本地助手"),
            "fast",
            None,
        )
        .expect("create aliased conversation");
        assert_eq!(detail.conversation.model, "qwen3:4b");
        assert_eq!(detail.conversation.model_alias, "本地助手");

        let mut connection = connection;
        let detail = create_conversation_with_message_alias(
            &mut connection,
            "conversation-alias-2",
            "qwen3:4b",
            Some("问答助手"),
            "fast",
            None,
            message("message-alias", "conversation-alias-2", None),
        )
        .expect("create aliased conversation with message");
        assert_eq!(detail.conversation.model_alias, "问答助手");
    }

    #[test]
    fn new_conversations_receive_sequential_titles() {
        let connection = database();
        let first = create_conversation_with_alias(
            &connection,
            "conversation-title-1",
            "qwen3:4b",
            None,
            "fast",
            None,
        )
        .expect("create first conversation");
        let second = create_conversation_with_alias(
            &connection,
            "conversation-title-2",
            "qwen3:4b",
            None,
            "fast",
            None,
        )
        .expect("create second conversation");

        assert_eq!(first.conversation.title, "会话1");
        assert_eq!(second.conversation.title, "会话2");
    }

    #[test]
    fn migration_renames_legacy_untitled_conversations() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (3, '0');
                 CREATE TABLE conversations (
                   id TEXT PRIMARY KEY NOT NULL,
                   title TEXT NOT NULL,
                   model TEXT NOT NULL,
                   model_alias TEXT NOT NULL DEFAULT '',
                   mode TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                 INSERT INTO conversations(id, title, model, mode, created_at, updated_at) VALUES
                   ('legacy-1', '新对话', 'qwen3:4b', 'fast', '1', '1'),
                   ('legacy-2', '新对话', 'qwen3:4b', 'fast', '2', '2'),
                   ('existing-number', '会话1', 'qwen3:4b', 'fast', '3', '3');",
            )
            .expect("create legacy schema");

        migrate(&connection).expect("upgrade legacy titles");
        let first: String = connection
            .query_row(
                "SELECT title FROM conversations WHERE id = 'legacy-1'",
                [],
                |row| row.get(0),
            )
            .expect("read first title");
        let second: String = connection
            .query_row(
                "SELECT title FROM conversations WHERE id = 'legacy-2'",
                [],
                |row| row.get(0),
            )
            .expect("read second title");
        assert_eq!(first, "会话2");
        assert_eq!(second, "会话3");
    }

    #[test]
    fn model_aliases_are_persisted_per_model_and_normalized() {
        let connection = database();
        let settings = update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: false,
                default_mode: "fast".to_string(),
                default_model: " qwen3:4b ".to_string(),
                model_aliases: BTreeMap::from([
                    (" qwen3:4b ".to_string(), " 本地助手 ".to_string()),
                    ("llama3".to_string(), "".to_string()),
                    (" ".to_string(), "ignored".to_string()),
                ]),
                context_size: 16384,
                output_token_limit: 2048,
                reasoning_token_limit: 2048,
            },
        )
        .expect("save model aliases");

        assert_eq!(settings.default_model, "qwen3:4b");
        assert_eq!(
            settings.model_aliases.get("qwen3:4b").map(String::as_str),
            Some("本地助手")
        );
        assert_eq!(
            settings.model_aliases.get("llama3").map(String::as_str),
            Some("")
        );
        assert!(!settings.model_aliases.contains_key(" "));

        let loaded = get_settings(&connection).expect("load model aliases");
        assert_eq!(loaded.model_aliases, settings.model_aliases);
    }

    #[test]
    fn context_size_is_persisted_and_validated() {
        let connection = database();
        let settings = update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: false,
                default_mode: "fast".to_string(),
                default_model: String::new(),
                model_aliases: BTreeMap::new(),
                context_size: 16384,
                output_token_limit: 2048,
                reasoning_token_limit: 2048,
            },
        )
        .expect("save context size");

        assert_eq!(settings.context_size, 16384);
        assert_eq!(
            get_settings(&connection)
                .expect("load context size")
                .context_size,
            16384
        );

        let invalid = update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: false,
                default_mode: "fast".to_string(),
                default_model: String::new(),
                model_aliases: BTreeMap::new(),
                context_size: 12345,
                output_token_limit: 2048,
                reasoning_token_limit: 2048,
            },
        )
        .expect_err("reject invalid context size");
        assert!(invalid.contains("上下文大小"));
    }

    #[test]
    fn output_token_limit_is_persisted_and_validated() {
        let connection = database();
        let settings = update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: false,
                default_mode: "fast".to_string(),
                default_model: String::new(),
                model_aliases: BTreeMap::new(),
                context_size: 4096,
                output_token_limit: 4096,
                reasoning_token_limit: 8192,
            },
        )
        .expect("save output token limit");

        assert_eq!(settings.output_token_limit, 4096);
        assert_eq!(settings.reasoning_token_limit, 8192);
        assert_eq!(
            get_settings(&connection)
                .expect("load output token limit")
                .output_token_limit,
            4096
        );
        assert_eq!(
            get_settings(&connection)
                .expect("load reasoning token limit")
                .reasoning_token_limit,
            8192
        );

        let invalid = update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: false,
                default_mode: "fast".to_string(),
                default_model: String::new(),
                model_aliases: BTreeMap::new(),
                context_size: 4096,
                output_token_limit: 12345,
                reasoning_token_limit: 2048,
            },
        )
        .expect_err("reject invalid output token limit");
        assert!(invalid.contains("输出消息 token 上限"));

        let invalid = update_settings(
            &connection,
            AppSettings {
                theme: "system".to_string(),
                save_thinking: false,
                default_mode: "fast".to_string(),
                default_model: String::new(),
                model_aliases: BTreeMap::new(),
                context_size: 4096,
                output_token_limit: 2048,
                reasoning_token_limit: 12345,
            },
        )
        .expect_err("reject invalid reasoning token limit");
        assert!(invalid.contains("推理输出 token 上限"));
    }

    #[test]
    fn legacy_single_model_alias_is_migrated_to_model_map() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (2, '0');
                 CREATE TABLE conversations (
                   id TEXT PRIMARY KEY NOT NULL,
                   title TEXT NOT NULL,
                   model TEXT NOT NULL,
                   model_alias TEXT NOT NULL DEFAULT '',
                   mode TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                 INSERT INTO settings(key, value) VALUES ('default_model', 'qwen3:4b'), ('model_alias', '本地助手');",
            )
            .expect("create v2 schema");

        migrate(&connection).expect("upgrade v2 schema");
        let settings = get_settings(&connection).expect("load migrated settings");
        assert_eq!(
            settings.model_aliases.get("qwen3:4b").map(String::as_str),
            Some("本地助手")
        );
    }
}
