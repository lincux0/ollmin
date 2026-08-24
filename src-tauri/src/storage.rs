use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub model: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    pub conversation: ConversationSummary,
    pub messages: Vec<StoredMessage>,
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

    if applied.unwrap_or(0) < SCHEMA_VERSION {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS conversations (
                   id TEXT PRIMARY KEY NOT NULL,
                   title TEXT NOT NULL,
                   model TEXT NOT NULL,
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
                   ('default_mode', 'fast');",
            )
            .map_err(|error| format!("执行数据库迁移失败：{error}"))?;
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
            "SELECT c.id, c.title, c.model, c.mode, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
             FROM conversations c
             WHERE LOWER(c.title) LIKE LOWER(?1)
                OR LOWER(c.model) LIKE LOWER(?1)
                OR EXISTS (
                  SELECT 1 FROM messages sm
                  WHERE sm.conversation_id = c.id AND LOWER(sm.content) LIKE LOWER(?1)
                )
             ORDER BY c.updated_at DESC",
        )
        .map_err(|error| format!("准备会话列表查询失败：{error}"))?;
    let rows = statement
        .query_map(params![search], |row| {
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                model: row.get(2)?,
                mode: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                message_count: row.get::<_, i64>(6)? as u32,
            })
        })
        .map_err(|error| format!("读取会话列表失败：{error}"))?;

    rows.map(|row| row.map_err(|error| format!("读取会话记录失败：{error}")))
        .collect()
}

pub fn create_conversation(
    connection: &Connection,
    id: &str,
    model: &str,
    mode: &str,
    title: Option<&str>,
) -> Result<ConversationDetail, String> {
    let id = required(id, "会话 ID")?;
    let model = required(model, "模型名称")?;
    let mode = required(mode, "性能模式")?;
    validate_mode(&mode)?;
    let now = timestamp();
    let title = normalize_title(title.unwrap_or("新对话"));
    connection
        .execute(
            "INSERT OR IGNORE INTO conversations(id, title, model, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, title, model, mode, now],
        )
        .map_err(|error| format!("创建会话失败：{error}"))?;
    get_conversation(connection, &id)
}

pub fn get_conversation(connection: &Connection, id: &str) -> Result<ConversationDetail, String> {
    let id = required(id, "会话 ID")?;
    let conversation = connection
        .query_row(
            "SELECT c.id, c.title, c.model, c.mode, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
             FROM conversations c WHERE c.id = ?1",
            params![id],
            |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    model: row.get(2)?,
                    mode: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    message_count: row.get::<_, i64>(6)? as u32,
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
            })
        })
        .map_err(|error| format!("读取消息失败：{error}"))?;
    let messages = rows
        .map(|row| row.map_err(|error| format!("读取消息记录失败：{error}")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ConversationDetail {
        conversation,
        messages,
    })
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

pub fn save_message(connection: &Connection, input: MessageInput) -> Result<(), String> {
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

pub fn get_settings(connection: &Connection) -> Result<AppSettings, String> {
    let mut settings = AppSettings {
        theme: "system".to_string(),
        save_thinking: false,
        default_mode: "fast".to_string(),
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
            _ => {}
        }
    }
    Ok(settings)
}

pub fn update_settings(
    connection: &Connection,
    settings: AppSettings,
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
    for (key, value) in [
        ("theme", settings.theme.clone()),
        ("save_thinking", settings.save_thinking.to_string()),
        ("default_mode", settings.default_mode.clone()),
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
        clear_conversations, create_conversation, get_conversation, get_settings,
        list_conversations, migrate, rename_conversation, save_message, update_settings,
        AppSettings, MessageInput,
    };
    use rusqlite::Connection;
    use serde_json::json;

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

    #[test]
    fn migration_is_idempotent_and_defaults_are_available() {
        let connection = database();
        migrate(&connection).expect("second migration");
        let settings = get_settings(&connection).expect("settings");
        assert_eq!(settings.theme, "system");
        assert!(!settings.save_thinking);
        assert_eq!(settings.default_mode, "fast");
    }

    #[test]
    fn messages_cascade_when_conversation_is_deleted() {
        let connection = database();
        create_conversation(&connection, "conversation-a", "qwen3:4b", "fast", None)
            .expect("create");
        save_message(
            &connection,
            message("message-a", "conversation-a", Some("private")),
        )
        .expect("save");
        clear_conversations(&connection).expect("clear");
        assert!(get_conversation(&connection, "conversation-a").is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn thinking_is_not_persisted_until_setting_is_enabled() {
        let connection = database();
        create_conversation(&connection, "conversation-b", "qwen3:4b", "fast", None)
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
        create_conversation(&connection, "conversation-c", "qwen3:4b", "fast", None)
            .expect("create");
        save_message(&connection, message("message-d", "conversation-c", None)).expect("save");
        rename_conversation(&connection, "conversation-c", "本地问答").expect("rename");
        let results = list_conversations(&connection, Some("本地")).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "本地问答");
    }
}
