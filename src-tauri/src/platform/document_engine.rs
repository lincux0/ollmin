use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentLocation {
    pub(crate) label: String,
    pub(crate) page: Option<usize>,
    pub(crate) sheet: Option<String>,
    pub(crate) row: Option<usize>,
    pub(crate) column: Option<usize>,
}

impl DocumentLocation {
    pub(crate) fn labeled(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            page: None,
            sheet: None,
            row: None,
            column: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentBlock {
    pub(crate) id: String,
    pub(crate) content: String,
    pub(crate) metadata: BTreeMap<String, String>,
    pub(crate) location: DocumentLocation,
}

impl DocumentBlock {
    pub(crate) fn new(
        id: impl Into<String>,
        content: impl Into<String>,
        location: DocumentLocation,
    ) -> Self {
        Self {
            id: id.into(),
            content: content.into(),
            metadata: BTreeMap::new(),
            location,
        }
    }

    pub(crate) fn with_metadata(
        mut self,
        key: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentVersion {
    pub(crate) id: String,
    pub(crate) source_digest: Option<String>,
    pub(crate) blocks: Vec<DocumentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) versions: Vec<DocumentVersion>,
}

#[cfg(test)]
mod tests {
    use super::{DocumentBlock, DocumentLocation};

    #[test]
    fn blocks_keep_stable_identity_location_and_metadata() {
        let block = DocumentBlock::new("block-1", "正文", DocumentLocation::labeled("第 1 页"))
            .with_metadata("kind", "paragraph");
        assert_eq!(block.id, "block-1");
        assert_eq!(block.location.label, "第 1 页");
        assert_eq!(block.metadata.get("kind"), Some(&"paragraph".to_string()));
    }
}
