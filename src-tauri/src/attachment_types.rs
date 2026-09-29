use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    pub text_characters: usize,
    pub chunk_count: usize,
    pub page_count: Option<usize>,
    pub sheets: Vec<SpreadsheetSheetSummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheetSummary {
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    pub non_empty_cells: usize,
    pub headers: Vec<String>,
}

/// Parsed content never leaves the local process except when it is explicitly
/// included in an Ollama request. The UI receives only `AttachmentSummary`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedAttachment {
    #[serde(flatten)]
    pub summary: AttachmentSummary,
    pub(crate) chunks: Vec<AttachmentChunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AttachmentChunk {
    pub(crate) content: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum AttachmentKind {
    Docx,
    Pdf,
    Excel,
}

impl AttachmentKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Docx => "DOCX",
            Self::Pdf => "PDF",
            Self::Excel => "Excel",
        }
    }
}

#[derive(Debug)]
pub(crate) struct TextFragment {
    pub(crate) location: String,
    pub(crate) content: String,
}
