use std::io::Read;
use std::process::Command;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use shared_child::SharedChild;

#[cfg(windows)]
pub fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
#[inline]
pub fn hide_console(_cmd: &mut Command) {}

/// Cap per stream so a runaway child cannot exhaust memory through its pipes.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

pub struct ProcOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Run `cmd` to completion, killing it past `timeout_secs`. The caller
/// configures the command (stdio must already be piped).
pub fn run_with_timeout(mut cmd: Command, timeout_secs: u64) -> std::io::Result<ProcOutput> {
    let child = Arc::new(SharedChild::spawn(&mut cmd)?);
    let mut stdout_pipe = child.take_stdout();
    let mut stderr_pipe = child.take_stderr();

    let stdout_handle = thread::spawn(move || drain(stdout_pipe.as_mut()));
    let stderr_handle = thread::spawn(move || drain(stderr_pipe.as_mut()));

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let (exit_code, timed_out) = match rx.recv_timeout(Duration::from_secs(timeout_secs.max(1))) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(std::io::Error::other("wait thread disconnected"))
        }
    };

    Ok(ProcOutput {
        stdout: stdout_handle.join().unwrap_or_default(),
        stderr: stderr_handle.join().unwrap_or_default(),
        exit_code,
        timed_out,
    })
}

fn drain<R: Read>(reader: Option<&mut R>) -> Vec<u8> {
    let Some(reader) = reader else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    while let Ok(read) = reader.read(&mut chunk) {
        if read == 0 {
            break;
        }
        let room = MAX_OUTPUT_BYTES.saturating_sub(out.len());
        if room == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..read.min(room)]);
    }
    out
}
