use rusqlite::{Connection, OptionalExtension};

pub(crate) const SCHEMA_VERSION: i64 = 1;

const MIGRATION_V1: &str = r#"
CREATE TABLE translations (
  cache_key TEXT PRIMARY KEY NOT NULL CHECK(length(cache_key) = 64),
  source_text_hash TEXT NOT NULL CHECK(length(source_text_hash) = 64),
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  translation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX translations_last_accessed_idx
  ON translations(last_accessed_at);
"#;

pub(crate) fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    match version {
        0 => {
            let translations_table_exists = connection
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'translations'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if translations_table_exists {
                return Err(rusqlite::Error::InvalidQuery);
            }

            connection.pragma_update(None, "auto_vacuum", "FULL")?;
            let transaction = connection.transaction()?;
            transaction.execute_batch(MIGRATION_V1)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
            Ok(())
        }
        SCHEMA_VERSION => Ok(()),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
