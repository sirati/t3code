//! Keeps a provider CLI alive while the T3 Code server that started it restarts.
//!
//! `launch` is what the server runs in place of the CLI. It starts a detached keeper, which runs
//! the CLI, and then only copies bytes: its stdin to the CLI and the CLI's stdout, stderr, and
//! exit status back. When the server goes away the keeper keeps the CLI running and holds its
//! output until a new server runs `attach`. Nothing here reads or changes what the CLI says.

use std::collections::VecDeque;
use std::ffi::CString;
use std::io::{self, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::{env, fs, process, thread};

const STDIN: u8 = 0;
const STDOUT: u8 = 1;
const STDERR: u8 = 2;
const EXIT: u8 = 3;
const SIGNAL: u8 = 4;
const DETACH: u8 = 5;
const DETACHED: u8 = 6;
/// The first frame on a connection says what it is: a frontend taking over, or a liveness probe.
const ATTACH: u8 = 7;
const PROBE: u8 = 8;

/// `launch` and `attach` exit with this after letting go of a session that keeps running.
const DETACHED_EXIT_CODE: i32 = 75;
/// `attach` exits with this when no keeper serves the socket.
const NO_SESSION_EXIT_CODE: i32 = 125;
/// Output held while no server is attached; past this the CLI waits on its own writes.
const MAX_HELD_BYTES: usize = 64 * 1024 * 1024;
const READY_FD_ENV: &str = "T3_SESSION_KEEPER_READY_FD";

fn write_frame(stream: &mut UnixStream, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    stream.write_all(&frame)
}

fn read_frame(stream: &mut UnixStream) -> Option<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    stream.read_exact(&mut header).ok()?;
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).ok()?;
    Some((header[0], payload))
}

fn encode_exit(code: i32, signal: i32) -> Vec<u8> {
    [code.to_be_bytes(), signal.to_be_bytes()].concat()
}

fn decode_i32(payload: &[u8], at: usize) -> i32 {
    payload
        .get(at..at + 4)
        .map(|bytes| i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .unwrap_or(0)
}

fn fail(message: &str, code: i32) -> ! {
    eprintln!("t3-session-keeper: {message}");
    process::exit(code)
}

// ---------------------------------------------------------------- keeper

struct State {
    frontend: Option<(u64, UnixStream)>,
    next_frontend: u64,
    held: VecDeque<(u8, Vec<u8>)>,
    held_bytes: usize,
    exit: Option<Vec<u8>>,
    exit_delivered: bool,
    kill_requested: bool,
}

struct Keeper {
    state: Mutex<State>,
    changed: Condvar,
    cli_stdin: Mutex<Option<process::ChildStdin>>,
    cli_group: i32,
}

impl Keeper {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn signal_cli(&self, signal: i32) {
        unsafe { libc::killpg(self.cli_group, signal) };
    }

    /// Sends CLI output to the attached server, or holds it until one attaches.
    fn deliver(&self, kind: u8, payload: Vec<u8>) {
        let mut state = self.lock();
        loop {
            if let Some((_, stream)) = state.frontend.as_mut() {
                if write_frame(stream, kind, &payload).is_ok() {
                    return;
                }
                self.lose_frontend(&mut state);
                continue;
            }
            if state.held_bytes < MAX_HELD_BYTES || state.held.is_empty() {
                state.held_bytes += payload.len();
                state.held.push_back((kind, payload));
                return;
            }
            state = self.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// A server that asked for the CLI to stop and then vanished still wants it stopped.
    fn lose_frontend(&self, state: &mut State) {
        state.frontend = None;
        if state.kill_requested && state.exit.is_none() {
            self.signal_cli(libc::SIGKILL);
        }
    }

    fn attach(self: &Arc<Self>, mut stream: UnixStream) {
        let mut state = self.lock();
        if let Some((_, previous)) = state.frontend.take() {
            let _ = previous.shutdown(std::net::Shutdown::Both);
        }
        while let Some((kind, payload)) = state.held.pop_front() {
            if write_frame(&mut stream, kind, &payload).is_err() {
                state.held.push_front((kind, payload));
                return;
            }
            state.held_bytes -= payload.len();
        }
        self.changed.notify_all();
        if let Some(exit) = state.exit.clone() {
            if write_frame(&mut stream, EXIT, &exit).is_ok() {
                state.exit_delivered = true;
                self.changed.notify_all();
            }
            return;
        }
        let Ok(reader) = stream.try_clone() else { return };
        let id = state.next_frontend;
        state.next_frontend += 1;
        state.kill_requested = false;
        state.frontend = Some((id, stream));
        drop(state);
        let keeper = Arc::clone(self);
        thread::spawn(move || keeper.serve_frontend(id, reader));
    }

    fn serve_frontend(&self, id: u64, mut reader: UnixStream) {
        while let Some((kind, payload)) = read_frame(&mut reader) {
            match kind {
                STDIN => {
                    let mut stdin = self.cli_stdin.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(pipe) = stdin.as_mut() {
                        if pipe.write_all(&payload).and_then(|()| pipe.flush()).is_err() {
                            *stdin = None;
                        }
                    }
                }
                SIGNAL => {
                    self.lock().kill_requested = true;
                    self.signal_cli(decode_i32(&payload, 0));
                }
                DETACH => {
                    let mut state = self.lock();
                    if state.frontend.as_ref().is_some_and(|(current, _)| *current == id) {
                        if let Some((_, mut stream)) = state.frontend.take() {
                            let _ = write_frame(&mut stream, DETACHED, &[]);
                        }
                    }
                    return;
                }
                _ => {}
            }
        }
        let mut state = self.lock();
        if state.frontend.as_ref().is_some_and(|(current, _)| *current == id) {
            self.lose_frontend(&mut state);
        }
    }
}

fn report_ready(message: &str) {
    let Some(fd) = env::var(READY_FD_ENV).ok().and_then(|fd| fd.parse::<i32>().ok()) else {
        return;
    };
    let mut ready = unsafe { fs::File::from_raw_fd(fd) };
    let _ = ready.write_all(message.as_bytes());
}

fn serve(socket: &str, command: &[String]) -> ! {
    // The CLI must not inherit the ready pipe, or launch would wait for it to exit.
    if let Some(fd) = env::var(READY_FD_ENV).ok().and_then(|fd| fd.parse::<i32>().ok()) {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    if UnixStream::connect(socket).is_ok() {
        report_ready("a session keeper already serves this socket\n");
        process::exit(1);
    }
    let _ = fs::remove_file(socket);
    let listener = match UnixListener::bind(socket) {
        Ok(listener) => listener,
        Err(error) => {
            report_ready(&format!("cannot listen on {socket}: {error}\n"));
            process::exit(1);
        }
    };
    let _ = fs::set_permissions(socket, fs::Permissions::from_mode(0o600));
    let mut child = match Command::new(&command[0])
        .args(&command[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(socket);
            report_ready(&format!("cannot start {}: {error}\n", command[0]));
            process::exit(1);
        }
    };
    let keeper = Arc::new(Keeper {
        state: Mutex::new(State {
            frontend: None,
            next_frontend: 0,
            held: VecDeque::new(),
            held_bytes: 0,
            exit: None,
            exit_delivered: false,
            kill_requested: false,
        }),
        changed: Condvar::new(),
        cli_stdin: Mutex::new(child.stdin.take()),
        cli_group: child.id() as i32,
    });
    let readers: Vec<_> = [(STDOUT, child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>)),
        (STDERR, child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>))]
    .into_iter()
    .filter_map(|(kind, pipe)| pipe.map(|pipe| (kind, pipe)))
    .map(|(kind, mut pipe)| {
        let keeper = Arc::clone(&keeper);
        thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            while let Ok(read) = pipe.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                keeper.deliver(kind, buffer[..read].to_vec());
            }
        })
    })
    .collect();
    {
        let keeper = Arc::clone(&keeper);
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let keeper = Arc::clone(&keeper);
                thread::spawn(move || match read_frame(&mut stream) {
                    Some((ATTACH, _)) => keeper.attach(stream),
                    Some((PROBE, _)) => {
                        let _ = write_frame(&mut stream, PROBE, &[]);
                    }
                    _ => {}
                });
            }
        });
    }
    report_ready("ok\n");

    let status = child.wait();
    // Like the CLI's own server, end what the CLI left running in its group.
    keeper.signal_cli(libc::SIGKILL);
    for reader in readers {
        let _ = reader.join();
    }
    let (code, signal) = match status {
        Ok(status) => (status.code().unwrap_or(-1), status.signal().unwrap_or(0)),
        Err(_) => (-1, 0),
    };
    let exit = encode_exit(code, signal);
    let mut state = keeper.lock();
    if let Some((_, stream)) = state.frontend.as_mut() {
        state.exit_delivered = write_frame(stream, EXIT, &exit).is_ok();
    }
    state.exit = Some(exit);
    // The exit status waits for a server to collect it, so the session never ends unseen.
    while !state.exit_delivered {
        state = keeper.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    drop(state);
    let _ = fs::remove_file(socket);
    process::exit(0)
}

// ---------------------------------------------------------------- frontend

static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);
/// Set once the server asked to detach: input it writes after that must not reach the CLI.
static DETACHING: AtomicBool = AtomicBool::new(false);

extern "C" fn forward_signal(signal: libc::c_int) {
    if signal == libc::SIGUSR1 {
        DETACHING.store(true, Ordering::SeqCst);
    }
    let byte = signal as u8;
    let fd = SIGNAL_PIPE.load(Ordering::Relaxed);
    unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
}

/// Catches the server's signals from the start, so one sent before the socket is up still counts.
fn catch_signals() -> fs::File {
    let mut pipe = [0i32; 2];
    unsafe {
        libc::pipe(pipe.as_mut_ptr());
        libc::fcntl(pipe[0], libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(pipe[1], libc::F_SETFD, libc::FD_CLOEXEC);
        SIGNAL_PIPE.store(pipe[1], Ordering::Relaxed);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGUSR1] {
            libc::signal(signal, forward_signal as *const () as libc::sighandler_t);
        }
        fs::File::from_raw_fd(pipe[0])
    }
}

fn frontend(mut stream: UnixStream, mut signals: fs::File) -> ! {
    if write_frame(&mut stream, ATTACH, &[]).is_err() {
        fail("cannot attach to the session", 1);
    }
    let writer = Arc::new(Mutex::new(match stream.try_clone() {
        Ok(writer) => writer,
        Err(error) => fail(&format!("cannot use the session socket: {error}"), 1),
    }));
    {
        let writer = Arc::clone(&writer);
        thread::spawn(move || {
            let mut byte = [0u8; 1];
            while signals.read_exact(&mut byte).is_ok() {
                let signal = byte[0] as i32;
                let mut stream = writer.lock().unwrap_or_else(|p| p.into_inner());
                let _ = if signal == libc::SIGUSR1 {
                    write_frame(&mut stream, DETACH, &[])
                } else {
                    write_frame(&mut stream, SIGNAL, &signal.to_be_bytes())
                };
            }
        });
    }
    {
        let writer = Arc::clone(&writer);
        thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut buffer = vec![0u8; 64 * 1024];
            // Stdin closing means the server went away, not that the CLI should see end of input.
            while let Ok(read) = stdin.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                if DETACHING.load(Ordering::SeqCst) {
                    continue;
                }
                let mut stream = writer.lock().unwrap_or_else(|p| p.into_inner());
                if write_frame(&mut stream, STDIN, &buffer[..read]).is_err() {
                    break;
                }
            }
        });
    }
    let mut reader = stream;
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr();
    while let Some((kind, payload)) = read_frame(&mut reader) {
        match kind {
            STDOUT => {
                if stdout.write_all(&payload).and_then(|()| stdout.flush()).is_err() {
                    process::exit(1);
                }
            }
            STDERR => {
                let _ = stderr.write_all(&payload);
            }
            EXIT => {
                let (code, signal) = (decode_i32(&payload, 0), decode_i32(&payload, 4));
                let _ = stdout.flush();
                if signal != 0 {
                    unsafe {
                        libc::signal(signal, libc::SIG_DFL);
                        libc::raise(signal);
                    }
                }
                process::exit(code)
            }
            DETACHED => {
                let _ = stdout.flush();
                process::exit(DETACHED_EXIT_CODE)
            }
            _ => {}
        }
    }
    fail("the session keeper went away", 1)
}

fn launch(socket: &str, command: &[String], signals: fs::File) -> ! {
    let argv: Vec<CString> = command
        .iter()
        .map(|arg| CString::new(arg.as_str()).unwrap_or_else(|_| fail("argument contains NUL", 2)))
        .collect();
    let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());
    let mut ready = [0i32; 2];
    if unsafe { libc::pipe(ready.as_mut_ptr()) } != 0 {
        fail("cannot create the ready pipe", 1);
    }
    let ready_env = CString::new(format!("{READY_FD_ENV}={}", ready[1])).unwrap_or_default();
    let dev_null = CString::new("/dev/null").unwrap_or_default();
    match unsafe { libc::fork() } {
        -1 => fail("cannot fork", 1),
        0 => unsafe {
            // A new session and a second fork leave the keeper outside the server's process tree.
            libc::setsid();
            if libc::fork() != 0 {
                libc::_exit(0);
            }
            let null = libc::open(dev_null.as_ptr(), libc::O_RDWR);
            for fd in 0..3 {
                libc::dup2(null, fd);
            }
            libc::close(ready[0]);
            libc::putenv(ready_env.as_ptr() as *mut libc::c_char);
            libc::execvp(argv_ptrs[0], argv_ptrs.as_ptr());
            let message = b"cannot execute the session command\n";
            libc::write(ready[1], message.as_ptr().cast(), message.len());
            libc::_exit(127);
        },
        child => unsafe {
            let mut status = 0;
            libc::waitpid(child, &mut status, 0);
            libc::close(ready[1]);
        },
    }
    let mut report = String::new();
    let _ = unsafe { fs::File::from_raw_fd(ready[0]) }.read_to_string(&mut report);
    if report.trim() != "ok" {
        let detail = if report.is_empty() { "the session keeper did not start" } else { report.trim() };
        fail(detail, 127);
    }
    match UnixStream::connect(socket) {
        Ok(stream) => frontend(stream, signals),
        Err(error) => fail(&format!("cannot reach the session keeper: {error}"), 1),
    }
}

fn stop(socket: &str) -> ! {
    let Ok(mut stream) = UnixStream::connect(socket) else { process::exit(0) };
    let _ = write_frame(&mut stream, ATTACH, &[]);
    let _ = write_frame(&mut stream, SIGNAL, &libc::SIGTERM.to_be_bytes());
    if let Ok(mut escalate) = stream.try_clone() {
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(10));
            let _ = write_frame(&mut escalate, SIGNAL, &libc::SIGKILL.to_be_bytes());
        });
    }
    while let Some((kind, _)) = read_frame(&mut stream) {
        if kind == EXIT {
            break;
        }
    }
    process::exit(0)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command_after = |at: usize| -> Vec<String> {
        match args.get(at).map(String::as_str) {
            Some("--") if args.len() > at + 1 => args[at + 1..].to_vec(),
            _ => fail("expected -- <command> [args...]", 2),
        }
    };
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("launch"), Some(socket)) => launch(socket, &command_after(2), catch_signals()),
        (Some("serve"), Some(socket)) => serve(socket, &command_after(2)),
        (Some("attach"), Some(socket)) => match UnixStream::connect(socket) {
            Ok(stream) => frontend(stream, catch_signals()),
            Err(_) => fail("no session to attach to", NO_SESSION_EXIT_CODE),
        },
        (Some("stop"), Some(socket)) => stop(socket),
        _ => fail(
            "usage: t3-session-keeper launch|serve <socket> -- <command> [args...] | attach|stop <socket>",
            2,
        ),
    }
}

