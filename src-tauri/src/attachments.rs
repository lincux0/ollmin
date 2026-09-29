#[path = "attachment_context.rs"]
mod context;
#[path = "attachment_parsers.rs"]
mod parsers;
#[path = "attachment_types.rs"]
mod types;

pub const MAX_ATTACHMENT_COUNT: usize = 3;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 160;
const MAX_PDF_PAGE_DECOMPRESSED_BYTES: usize = 2 * 1024 * 1024;
const MAX_DOCX_ENTRIES: usize = 2_000;
const MAX_DOCX_XML_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_CHARACTERS: usize = 160_000;
const MAX_SPREADSHEET_CELLS: usize = 80_000;
const MAX_SPREADSHEET_CHARACTERS: usize = MAX_DOCUMENT_CHARACTERS;
const DOCUMENT_CHUNK_CHARACTERS: usize = 720;

pub(crate) use context::build_context;
pub(crate) use parsers::parse_paths;
pub use types::{AttachmentSummary, ParsedAttachment};

#[cfg(test)]
mod tests {
    use super::parsers::{account_spreadsheet_cell, chunk_fragments, detect_kind, parse_path};
    use super::types::{AttachmentChunk, TextFragment};
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn temporary_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ollmin-{name}-{}.docx", std::process::id()))
    }

    #[test]
    fn docx_parser_extracts_paragraphs_and_tables_as_text() {
        let path = temporary_file("attachment");
        let file = File::create(&path).expect("create docx fixture");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("create xml entry");
        archive
            .write_all(r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#.as_bytes())
            .expect("write xml");
        archive.finish().expect("finish docx fixture");

        let summary = parse_path(&path, "fixture".to_string()).expect("parse docx");
        assert_eq!(summary.summary.kind, "DOCX");
        assert_eq!(summary.summary.text_characters, 8);
        assert_eq!(summary.summary.chunk_count, 1);
        fs::remove_file(path).expect("remove docx fixture");
    }

    #[test]
    fn old_doc_is_rejected_with_conversion_guidance() {
        let error =
            detect_kind(Path::new("C:\\example.doc")).expect_err("old doc should be rejected");
        assert!(error.contains(".docx"));
    }

    #[test]
    fn chunks_preserve_source_locations() {
        let chunks = chunk_fragments(&[
            TextFragment {
                location: "第 1 页".to_string(),
                content: "甲".repeat(400),
            },
            TextFragment {
                location: "第 2 页".to_string(),
                content: "乙".repeat(400),
            },
        ]);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].content.starts_with("第 1 页"));
        assert!(chunks[1].content.starts_with("第 2 页"));
    }

    #[test]
    fn spreadsheet_limits_are_enforced_before_accumulating_more_rows() {
        let mut sheet_cells = MAX_SPREADSHEET_CELLS;
        let mut text_characters = 0;
        let error = account_spreadsheet_cell(0, &mut sheet_cells, &mut text_characters, 1)
            .expect_err("cell limit should be checked before another cell is accepted");
        assert!(error.contains("非空单元格"));

        let mut sheet_cells = 0;
        let mut text_characters = MAX_SPREADSHEET_CHARACTERS;
        let error = account_spreadsheet_cell(0, &mut sheet_cells, &mut text_characters, 1)
            .expect_err("text limit should be checked before another cell is accepted");
        assert!(error.contains("可提取文本"));
    }

    #[test]
    fn local_examples_are_checked_when_available() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples");
        let pdf = root.join("各级调研来访会务保障工作方案.pdf");
        if pdf.exists() {
            let summary = parse_path(&pdf, "example-pdf".to_string()).expect("parse supplied pdf");
            assert_eq!(summary.summary.kind, "PDF");
            assert!(summary.summary.page_count.unwrap_or_default() > 0);
            assert!(
                summary.summary.text_characters > 0,
                "supplied PDF should contain a text layer"
            );
            assert!(
                summary.summary.chunk_count > 0,
                "supplied PDF text should be chunked"
            );
            assert!(
                build_context(&[summary], "调研来访会务保障如何安排", 4096)
                    .expect("build supplied PDF context")
                    .is_some(),
                "supplied PDF should yield bounded chat context"
            );
        }

        let spreadsheet = root.join("计算机科学与技术学院.xlsx");
        if spreadsheet.exists() {
            let summary = parse_path(&spreadsheet, "example-xlsx".to_string())
                .expect("parse supplied spreadsheet");
            assert_eq!(summary.summary.kind, "Excel");
            assert!(!summary.summary.sheets.is_empty());
            assert!(summary
                .summary
                .sheets
                .iter()
                .any(|sheet| sheet.non_empty_cells > 0));
            assert!(
                build_context(&[summary], "计算机科学与技术学院有哪些数据", 4096)
                    .expect("build supplied spreadsheet context")
                    .is_some(),
                "supplied spreadsheet should yield bounded chat context"
            );
        }
    }

    #[test]
    fn context_is_bounded_and_marks_file_content_as_reference_data() {
        let attachment = ParsedAttachment {
            summary: AttachmentSummary {
                id: "fixture".to_string(),
                name: "资料.pdf".to_string(),
                kind: "PDF".to_string(),
                size_bytes: 1,
                text_characters: 10_000,
                chunk_count: 2,
                page_count: Some(2),
                sheets: Vec::new(),
                warnings: Vec::new(),
            },
            chunks: vec![
                AttachmentChunk {
                    content: "第 1 页：无关内容".repeat(200),
                },
                AttachmentChunk {
                    content: "第 2 页：调研会务保障安排".repeat(200),
                },
            ],
        };
        let context = build_context(&[attachment], "调研会务怎么安排", 4096)
            .expect("build context")
            .expect("context");
        assert!(context.contains("仅作为回答当前问题的参考资料"));
        assert!(context.contains("调研会务保障安排"));
        assert!(context.chars().count() <= 3_100);
    }
}
