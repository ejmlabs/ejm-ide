use crate::{HostAccessState, workspace::WorkspaceState};
use serde::Serialize;
use std::{
    io::{self, Read, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};

pub(crate) struct ProcessResult {
    pub output: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
    pub truncated: bool,
    pub timed_out: bool,
}

pub(crate) fn run_bounded(
    command: Command,
    timeout: Duration,
    limit: usize,
) -> Result<ProcessResult, String> {
    run_bounded_with_input(command, timeout, limit, None)
}

pub(crate) fn run_bounded_input(
    command: Command,
    timeout: Duration,
    limit: usize,
    input: Vec<u8>,
) -> Result<ProcessResult, String> {
    run_bounded_with_input(command, timeout, limit, Some(input))
}

fn run_bounded_with_input(
    mut command: Command,
    timeout: Duration,
    limit: usize,
    input: Option<Vec<u8>>,
) -> Result<ProcessResult, String> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start command: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("Command stdout is unavailable")?;
    let mut stderr = child.stderr.take().ok_or("Command stderr is unavailable")?;
    let mut stdin = child.stdin.take();
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        for descriptor in [
            Some(stdout.as_raw_fd()),
            Some(stderr.as_raw_fd()),
            stdin.as_ref().map(AsRawFd::as_raw_fd),
        ]
        .into_iter()
        .flatten()
        {
            #[allow(unsafe_code, reason = "fcntl has no safe standard library equivalent")]
            // SAFETY: Both descriptors come from live, owned child pipes. F_GETFL takes
            // no third argument; F_SETFL receives only those flags plus O_NONBLOCK.
            let result = unsafe {
                let flags = libc::fcntl(descriptor, libc::F_GETFL);
                if flags == -1 {
                    -1
                } else {
                    libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK)
                }
            };
            if result == -1 {
                terminate_process_group(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "Cannot configure command pipes: {}",
                    io::Error::last_os_error()
                ));
            }
        }
    }
    #[cfg(not(unix))]
    {
        terminate_process_group(&mut child);
        return Err("The command runner currently supports macOS and Linux.".into());
    }
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut truncated = false;
    let started = Instant::now();
    let mut timed_out = false;
    let input = input.unwrap_or_default();
    let mut sent = 0;
    let status = loop {
        capture_available(&mut stdout, &mut output, limit, &mut truncated);
        capture_available(&mut stderr, &mut errors, limit, &mut truncated);
        if let Some(pipe) = stdin.as_mut() {
            match send_available(pipe, &input, &mut sent) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                    stdin.take();
                }
                Err(error) => {
                    terminate_process_group(&mut child);
                    let _ = child.wait();
                    return Err(format!("Cannot send command input: {error}"));
                }
            }
            if sent == input.len() {
                stdin.take();
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                timed_out = true;
                break None;
            }
            Err(error) => {
                terminate_process_group(&mut child);
                let _ = child.wait();
                return Err(format!("Cannot wait for command: {error}"));
            }
        }
    };
    // Nonblocking pipes keep detached descendants from holding the command result open.
    terminate_process_group(&mut child);
    let _ = child.wait();
    for _ in 0..4 {
        capture_available(&mut stdout, &mut output, limit, &mut truncated);
        capture_available(&mut stderr, &mut errors, limit, &mut truncated);
    }
    Ok(ProcessResult {
        output,
        stderr: errors,
        exit_code: status.and_then(|status| status.code()).unwrap_or(-1),
        truncated,
        timed_out,
    })
}

fn send_available(target: &mut impl Write, input: &[u8], sent: &mut usize) -> io::Result<()> {
    for _ in 0..8 {
        if *sent == input.len() {
            break;
        }
        let end = input.len().min(*sent + 8192);
        match target.write(&input[*sent..end]) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => *sent += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn capture_available(
    source: &mut impl Read,
    output: &mut Vec<u8>,
    limit: usize,
    truncated: &mut bool,
) {
    let mut chunk = [0; 8192];
    for _ in 0..8 {
        match source.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                let keep = count.min(limit.saturating_sub(output.len()));
                output.extend_from_slice(&chunk[..keep]);
                *truncated |= keep < count;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn terminate_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    #[allow(
        unsafe_code,
        reason = "Native process-group termination has no safe standard library API"
    )]
    // SAFETY: The child was spawned in its own process group. Its positive process
    // id identifies only that group when negated, and kill does not access memory.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    command: String,
    output: String,
    exit_code: i32,
    timed_out: bool,
    truncated: bool,
}

#[tauri::command]
pub async fn terminal_run(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    command: String,
) -> Result<CommandResult, String> {
    host.check(&window, &auth)?;
    if command.trim().is_empty() || command.len() > 8192 || command.contains('\0') {
        return Err("Enter a command shorter than 8 KiB.".into());
    }
    let root = workspace.root_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        let shell = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let mut process = Command::new(shell);
        process.arg("-lc").arg(&command).current_dir(root);
        let result = run_bounded(process, Duration::from_secs(30), 512 * 1024)?;
        let mut output = String::from_utf8_lossy(&result.output).into_owned();
        if !result.stderr.is_empty() {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&String::from_utf8_lossy(&result.stderr));
        }
        if result.timed_out {
            output.push_str("\n[Command stopped after 30 seconds]\n");
        }
        if result.truncated {
            output.push_str("\n[Output truncated]\n");
        }
        Ok(CommandResult {
            command,
            output,
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            truncated: result.truncated,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_timeout_does_not_wait_for_descendants() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5 & wait"]);
        let started = Instant::now();
        let result = run_bounded(command, Duration::from_millis(150), 1024).unwrap();
        assert!(result.timed_out);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn command_output_is_bounded_without_a_timeout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '%2048s' x"]);
        let result = run_bounded(command, Duration::from_secs(5), 1024).unwrap();
        assert!(!result.timed_out);
        assert!(result.truncated);
        assert_eq!(result.output.len(), 1024);
        assert_eq!(result.exit_code, 0);
    }

    #[test]
    fn command_input_progresses_while_output_pipe_is_full() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "dd if=/dev/zero bs=1024 count=256 2>/dev/null; cat"]);
        let input = vec![b'x'; 256 * 1024];
        let result =
            run_bounded_input(command, Duration::from_secs(5), 1024 * 1024, input.clone()).unwrap();
        assert!(!result.timed_out);
        assert!(!result.truncated);
        assert_eq!(result.exit_code, 0);
        assert_eq!(&result.output[..256 * 1024], vec![0; 256 * 1024]);
        assert_eq!(&result.output[256 * 1024..], input);
    }

    #[test]
    fn command_input_timeout_does_not_wait_for_a_reader() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5"]);
        let started = Instant::now();
        let result = run_bounded_input(
            command,
            Duration::from_millis(150),
            1024,
            vec![b'x'; 256 * 1024],
        )
        .unwrap();
        assert!(result.timed_out);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
