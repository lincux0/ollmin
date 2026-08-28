use calamine::{open_workbook_auto, DataType, Reader};
use lopdf::Document;
use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

pub const MAX_ATTACHMENT_COUNT: usize = 3;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 160;
const MAX_PDF_PAGE_DECOMPRESSED_BYTES: usize = 2 * 1024 * 1024;
const MAX_DOCX_ENTRIES: usize = 2_000;
const MAX_DOCX_XML_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_CHARACTERS: usize = 160_000;
const MAX_SPREADSHEET_CELLS: usize = 80_000;
const DOCUMENT_CHUNK_CHARACTERS: usize = 720;

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheetSummary {
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    pub non_empty_cells: usize,
    pub headers: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum AttachmentKind {
    Docx,
    Pdf,
    Excel,
}

impl AttachmentKind {
    fn label(self) -> &'static str {
        match self {
            Self::Docx => "DOCX",
            Self::Pdf => "PDF",
            Self::Excel => "Excel",
        }
    }
}

#[derive(Debug)]
struct TextFragment {
    location: String,
    content: String,
}

pub fn parse_paths(paths: Vec<String>) -> Result<Vec<AttachmentSummary>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if paths.len() > MAX_ATTACHMENT_COUNT {
        return Err(format!("一次最多添加 {MAX_ATTACHMENT_COUNT} 个文件"));
    }

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    paths
        .iter()
        .enumerate()
        .map(|(index, value)| {
            parse_path(Path::new(value), format!("attachment-{started_at}-{index}"))
        })
        .collect()
}

fn parse_path(path: &Path, id: String) -> Result<AttachmentSummary, String> {
    validate_local_path(path)?;
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("只能添加普通本地文件".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件超过 {} MiB 限制",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别文件名".to_string())?
        .to_string();
    let kind = detect_kind(path)?;

    let mut summary = match kind {
        AttachmentKind::Pdf => parse_pdf(path, &id, &name, metadata.len())?,
        AttachmentKind::Docx => parse_docx(path, &id, &name, metadata.len())?,
        AttachmentKind::Excel => parse_spreadsheet(path, &id, &name, metadata.len())?,
    };
    summary.kind = kind.label().to_string();
    Ok(summary)
}

fn validate_local_path(path: &Path) -> Result<(), String> {
    let value = path.to_string_lossy();
    if !path.is_absolute() {
        return Err("仅允许由本地文件选择器返回的绝对路径".to_string());
    }
    if value.starts_with("\\\\") || value.starts_with("//") {
        return Err("不支持网络共享路径，请先将文件复制到本机磁盘".to_string());
    }
    Ok(())
}

fn detect_kind(path: &Path) -> Result<AttachmentKind, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "pdf" => Ok(AttachmentKind::Pdf),
        "docx" => Ok(AttachmentKind::Docx),
        "xls" | "xlsx" => Ok(AttachmentKind::Excel),
        "doc" => Err("暂不支持旧式 .doc 文件，请在 Word 中另存为 .docx 后再添加".to_string()),
        _ => Err("仅支持 PDF、DOCX 和 Excel（.xls/.xlsx）文件".to_string()),
    }
}

fn parse_pdf(
    path: &Path,
    id: &str,
    name: &str,
    size_bytes: u64,
) -> Result<AttachmentSummary, String> {
    let document = Document::load(path).map_err(|error| format!("无法打开 PDF：{error}"))?;
    let pages = document.get_pages();
    if pages.len() > MAX_PDF_PAGES {
        return Err(format!("PDF 页数超过 {MAX_PDF_PAGES} 页限制"));
    }

    let mut fragments = Vec::new();
    for page in pages.keys() {
        let content = document
            .extract_text_with_limit(&[*page], MAX_PDF_PAGE_DECOMPRESSED_BYTES)
            .map_err(|error| format!("PDF 第 {page} 页文本解析失败：{error}"))?;
        let content = normalize_text(&content);
        if !content.is_empty() {
            fragments.push(TextFragment {
                location: format!("第 {page} 页"),
                content,
            });
        }
    }

    let text_characters = fragments
        .iter()
        .map(|fragment| fragment.content.chars().count())
        .sum();
    if text_characters > MAX_DOCUMENT_CHARACTERS {
        return Err(format!(
            "PDF 可提取文本超过 {MAX_DOCUMENT_CHARACTERS} 字符限制"
        ));
    }
    let mut warnings = Vec::new();
    if fragments.is_empty() {
        warnings.push("未提取到可搜索文本；扫描件、图片型 PDF 和复杂版式暂不支持 OCR".to_string());
    }

    Ok(AttachmentSummary {
        id: id.to_string(),
        name: name.to_string(),
        kind: String::new(),
        size_bytes,
        text_characters,
        chunk_count: chunk_fragments(&fragments).len(),
        page_count: Some(pages.len()),
        sheets: Vec::new(),
        warnings,
    })
}

fn parse_docx(
    path: &Path,
    id: &str,
    name: &str,
    size_bytes: u64,
) -> Result<AttachmentSummary, String> {
    let file = File::open(path).map_err(|error| format!("无法打开 DOCX：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("DOCX 压缩包无效：{error}"))?;
    if archive.len() > MAX_DOCX_ENTRIES {
        return Err(format!("DOCX 文件条目超过 {MAX_DOCX_ENTRIES} 个限制"));
    }
    let document_xml = archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX 缺少正文 document.xml".to_string())?;
    if document_xml.size() > MAX_DOCX_XML_BYTES as u64 {
        return Err(format!(
            "DOCX 正文 XML 超过 {} MiB 限制",
            MAX_DOCX_XML_BYTES / 1024 / 1024
        ));
    }

    let mut xml = String::new();
    document_xml
        .take((MAX_DOCX_XML_BYTES + 1) as u64)
        .read_to_string(&mut xml)
        .map_err(|error| format!("无法读取 DOCX 正文：{error}"))?;
    if xml.len() > MAX_DOCX_XML_BYTES {
        return Err(format!(
            "DOCX 正文 XML 超过 {} MiB 限制",
            MAX_DOCX_XML_BYTES / 1024 / 1024
        ));
    }

    let fragments = extract_docx_paragraphs(&xml)?;
    let text_characters = fragments
        .iter()
        .map(|fragment| fragment.content.chars().count())
        .sum();
    if text_characters > MAX_DOCUMENT_CHARACTERS {
        return Err(format!("DOCX 正文超过 {MAX_DOCUMENT_CHARACTERS} 字符限制"));
    }
    let mut warnings = Vec::new();
    if fragments.is_empty() {
        warnings.push("未提取到正文段落；图片、批注、文本框和修订内容不会被解析".to_string());
    }

    Ok(AttachmentSummary {
        id: id.to_string(),
        name: name.to_string(),
        kind: String::new(),
        size_bytes,
        text_characters,
        chunk_count: chunk_fragments(&fragments).len(),
        page_count: None,
        sheets: Vec::new(),
        warnings,
    })
}

fn parse_spreadsheet(
    path: &Path,
    id: &str,
    name: &str,
    size_bytes: u64,
) -> Result<AttachmentSummary, String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|error| format!("无法打开 Excel：{error}"))?;
    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err("Excel 中没有可读取的工作表".to_string());
    }

    let mut sheets = Vec::new();
    let mut used_cells = 0usize;
    let mut text_characters = 0usize;
    for sheet_name in sheet_names {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| format!("工作表“{sheet_name}”解析失败：{error}"))?;
        let (rows, columns) = range.get_size();
        let mut headers = Vec::new();
        let mut non_empty_cells = 0usize;

        for row in range.rows() {
            let values: Vec<String> = row.iter().map(ToString::to_string).collect();
            if headers.is_empty() && values.iter().any(|value| !value.trim().is_empty()) {
                headers = values
                    .iter()
                    .map(|value| value.trim().to_string())
                    .collect();
            }
            for cell in row {
                if !cell.is_empty() {
                    non_empty_cells += 1;
                    text_characters += cell.to_string().chars().count();
                }
            }
        }

        used_cells = used_cells.saturating_add(non_empty_cells);
        if used_cells > MAX_SPREADSHEET_CELLS {
            return Err(format!(
                "Excel 非空单元格超过 {MAX_SPREADSHEET_CELLS} 个限制"
            ));
        }
        sheets.push(SpreadsheetSheetSummary {
            name: sheet_name,
            rows,
            columns,
            non_empty_cells,
            headers,
        });
    }

    Ok(AttachmentSummary {
        id: id.to_string(),
        name: name.to_string(),
        kind: String::new(),
        size_bytes,
        text_characters,
        chunk_count: 0,
        page_count: None,
        sheets,
        warnings: vec!["Excel 仅读取已保存的单元格值；不会执行宏、公式或外部链接".to_string()],
    })
}

fn extract_docx_paragraphs(xml: &str) -> Result<Vec<TextFragment>, String> {
    let mut reader = XmlReader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut in_paragraph = false;
    let mut paragraph = String::new();
    let mut paragraph_index = 0usize;
    let mut fragments = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => match event.name().as_ref() {
                "w:p" => {
                    in_paragraph = true;
                    paragraph.clear();
                }
                "w:tab" | "w:br" | "w:cr" if in_paragraph => paragraph.push(' '),
                _ => {}
            },
            Ok(Event::Empty(event)) => match event.name().as_ref() {
                "w:tab" | "w:br" | "w:cr" if in_paragraph => paragraph.push(' '),
                _ => {}
            },
            Ok(Event::Text(text)) if in_paragraph => {
                let decoded = unescape(text.as_ref())
                    .map_err(|error| format!("DOCX 文本转义无效：{error}"))?;
                paragraph.push_str(&decoded);
            }
            Ok(Event::End(event)) if event.name().as_ref() == "w:p" => {
                in_paragraph = false;
                let content = normalize_text(&paragraph);
                if !content.is_empty() {
                    paragraph_index += 1;
                    fragments.push(TextFragment {
                        location: format!("第 {paragraph_index} 段"),
                        content,
                    });
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("DOCX XML 解析失败：{error}")),
            _ => {}
        }
        buffer.clear();
    }
    Ok(fragments)
}

fn chunk_fragments(fragments: &[TextFragment]) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for fragment in fragments {
        let line = format!("{}：{}", fragment.location, fragment.content);
        if !current.is_empty()
            && current.chars().count() + line.chars().count() + 1 > DOCUMENT_CHUNK_CHARACTERS
        {
            chunks.push(current);
            current = String::new();
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(&line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

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
        assert_eq!(summary.kind, "DOCX");
        assert_eq!(summary.text_characters, 8);
        assert_eq!(summary.chunk_count, 1);
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
        assert!(chunks[0].starts_with("第 1 页"));
        assert!(chunks[1].starts_with("第 2 页"));
    }

    #[test]
    fn local_examples_are_checked_when_available() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples");
        let pdf = root.join("各级调研来访会务保障工作方案.pdf");
        if pdf.exists() {
            let summary = parse_path(&pdf, "example-pdf".to_string()).expect("parse supplied pdf");
            assert_eq!(summary.kind, "PDF");
            assert!(summary.page_count.unwrap_or_default() > 0);
            assert!(
                summary.text_characters > 0,
                "supplied PDF should contain a text layer"
            );
            assert!(
                summary.chunk_count > 0,
                "supplied PDF text should be chunked"
            );
        }

        let spreadsheet = root.join("计算机科学与技术学院.xlsx");
        if spreadsheet.exists() {
            let summary = parse_path(&spreadsheet, "example-xlsx".to_string())
                .expect("parse supplied spreadsheet");
            assert_eq!(summary.kind, "Excel");
            assert!(!summary.sheets.is_empty());
            assert!(summary.sheets.iter().any(|sheet| sheet.non_empty_cells > 0));
        }
    }
}
