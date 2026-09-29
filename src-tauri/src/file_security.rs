use std::fs::{self, File, OpenOptions};
use std::path::Path;

/// 打开一个不会在解析期间被其他进程替换或删除的普通本地文件。
/// 返回的句柄必须保持到哈希和格式解析全部完成。
pub(crate) fn open_regular_file_locked(path: &Path, label: &str) -> Result<File, String> {
    reject_reparse_components(path, label)?;
    let file = open_file(path, false).map_err(|error| format!("打开{label}失败：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("读取{label}信息失败：{error}"))?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(format!("{label}不是普通文件或包含重解析点"));
    }
    Ok(file)
}

fn reject_reparse_components(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label}必须是绝对路径"));
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("无法检查{label}路径组件：{error}"))?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(format!("{label}路径包含不受支持的符号链接或重解析点"));
        }
    }
    Ok(())
}

fn open_file(path: &Path, directory: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        let flags = FILE_FLAG_OPEN_REPARSE_POINT
            | if directory {
                FILE_FLAG_BACKUP_SEMANTICS
            } else {
                0
            };
        options.share_mode(FILE_SHARE_READ).custom_flags(flags);
    }
    #[cfg(not(windows))]
    let _ = directory;
    options.open(path)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}
