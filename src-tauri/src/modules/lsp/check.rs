// One-shot whole-project type check. The language server only answers for
// files that are open, so the Problems view needs a real compile to see errors
// in files the user has never touched. Run on demand only.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::modules::lsp::resolve;
use crate::modules::lsp::types::{LspDiagnostic, LspFileProblems};

/// A whole-project check is a compile; on a large project it is slow, and it is
/// only ever user-initiated, so the cap is generous.
const CHECK_TIMEOUT_SECS: u64 = 180;

pub fn project_check(root: &Path) -> Result<Vec<LspFileProblems>, String> {
    if !root.join("tsconfig.json").is_file() {
        return Err(format!(
            "No tsconfig.json in {}. A whole-project check needs one.",
            crate::modules::fs::to_canon(root)
        ));
    }
    let install = resolve::find_tsgo(root)?;

    let mut cmd = Command::new(&install.exe);
    cmd.arg("--noEmit")
        .arg("--pretty")
        .arg("false")
        .arg("-p")
        .arg(root)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let output = crate::modules::proc::run_with_timeout(cmd, CHECK_TIMEOUT_SECS)
        .map_err(|e| format!("project check failed: {e}"))?;
    if output.timed_out {
        return Err(format!("project check timed out after {CHECK_TIMEOUT_SECS}s"));
    }

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(parse_check_output(&text, root))
}

/// `main.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`
/// Positions are 1-based in the compiler's output and 0-based everywhere else.
pub fn parse_check_output(text: &str, root: &Path) -> Vec<LspFileProblems> {
    let mut by_file: Vec<LspFileProblems> = Vec::new();

    for line in text.lines() {
        let Some(parsed) = parse_check_line(line) else {
            // A wrapped continuation belongs to the message above it.
            if line.starts_with(' ') || line.starts_with('\t') {
                if let Some(last) = by_file.last_mut().and_then(|f| f.diagnostics.last_mut()) {
                    last.message.push('\n');
                    last.message.push_str(line.trim_end());
                }
            }
            continue;
        };

        let absolute = crate::modules::fs::to_canon(root.join(&parsed.file));
        match by_file.iter_mut().find(|f| f.path == absolute) {
            Some(entry) => entry.diagnostics.push(parsed.diagnostic),
            None => by_file.push(LspFileProblems {
                path: absolute,
                diagnostics: vec![parsed.diagnostic],
            }),
        }
    }

    by_file
}

struct ParsedLine {
    file: String,
    diagnostic: LspDiagnostic,
}

fn parse_check_line(line: &str) -> Option<ParsedLine> {
    // A path may itself contain parentheses, so the position is the last
    // parenthesised group before the `:` that starts the message.
    let open = line.rfind('(')?;
    let close = open + line[open..].find(')')?;
    let (row, column) = line[open + 1..close].split_once(',')?;
    let row: u32 = row.trim().parse().ok()?;
    // Some diagnostics carry a span like `(3,7-12)`; the start is enough.
    let column: u32 = column.trim().split('-').next()?.parse().ok()?;

    let rest = line[close + 1..].strip_prefix(':')?.trim_start();
    let (severity, rest) = if let Some(r) = rest.strip_prefix("error ") {
        (1u8, r)
    } else if let Some(r) = rest.strip_prefix("warning ") {
        (2, r)
    } else {
        (3, rest.strip_prefix("message ")?)
    };

    let (code, message) = rest.split_once(':')?;
    let code = code.trim();
    if !code.starts_with("TS") {
        return None;
    }

    let file = line[..open].trim();
    if file.is_empty() {
        return None;
    }

    Some(ParsedLine {
        file: file.to_string(),
        diagnostic: LspDiagnostic {
            start_line: row.saturating_sub(1),
            start_character: column.saturating_sub(1),
            end_line: row.saturating_sub(1),
            end_character: column.saturating_sub(1),
            severity,
            code: Some(code.to_string()),
            source: Some("ts".to_string()),
            message: message.trim().to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_compiler_line_format() {
        let text = "main.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n\
                    main.ts(4,19): error TS2345: Argument of type 'number' is not assignable.\n";
        let files = parse_check_output(text, Path::new("/proj"));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "/proj/main.ts");
        assert_eq!(files[0].diagnostics.len(), 2);
        let first = &files[0].diagnostics[0];
        assert_eq!((first.start_line, first.start_character), (2, 6));
        assert_eq!(first.code.as_deref(), Some("TS2322"));
        assert_eq!(first.severity, 1);
    }

    #[test]
    fn groups_by_file_in_first_seen_order() {
        let text = "a.ts(1,1): error TS1: a\nb.ts(1,1): error TS2: b\na.ts(2,1): error TS3: c\n";
        let files = parse_check_output(text, Path::new("/p"));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "/p/a.ts");
        assert_eq!(files[0].diagnostics.len(), 2);
        assert_eq!(files[1].diagnostics.len(), 1);
    }

    #[test]
    fn keeps_wrapped_message_continuations() {
        let text = "a.ts(1,1): error TS2345: Argument of type 'A' is not assignable.\n  Types of property 'x' are incompatible.\n";
        let files = parse_check_output(text, Path::new("/p"));
        assert!(files[0].diagnostics[0].message.contains("Types of property"));
    }

    #[test]
    fn ignores_summaries_and_noise() {
        let text = "Found 2 errors in 1 file.\n\nerrors  files\n     2  main.ts:3\n";
        assert!(parse_check_output(text, Path::new("/p")).is_empty());
    }

    #[test]
    fn handles_a_path_containing_parentheses() {
        let text = "src/my (old)/a.ts(9,2): error TS1005: ';' expected.\n";
        let files = parse_check_output(text, Path::new("/p"));
        assert_eq!(files[0].path, "/p/src/my (old)/a.ts");
        assert_eq!(files[0].diagnostics[0].start_line, 8);
    }

    #[test]
    fn severity_follows_the_keyword() {
        let text = "a.ts(1,1): warning TS6133: 'n' is declared but never used.\n";
        let files = parse_check_output(text, Path::new("/p"));
        assert_eq!(files[0].diagnostics[0].severity, 2);
    }
}
