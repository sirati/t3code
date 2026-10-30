//! Runs the real binary the way the server does: launch, detach, attach, stop.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const KEEPER: &str = env!("CARGO_BIN_EXE_t3-session-keeper");
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Session {
    socket: PathBuf,
    trigger: PathBuf,
}

impl Session {
    fn new() -> Self {
        let id = format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let dir = std::env::temp_dir();
        Session {
            socket: dir.join(format!("t3k-{id}.sock")),
            trigger: dir.join(format!("t3k-{id}.go")),
        }
    }

    fn launch(&self, script: &str) -> Frontend {
        let mut command = Command::new(KEEPER);
        // As the server does: launch runs a command that ends in `serve`, here without a scope wrapper.
        command.arg("launch").arg(&self.socket).arg("--").arg(KEEPER).arg("serve").arg(&self.socket);
        command.args(["--", "sh", "-c", script, "sh"]);
        command.arg(&self.trigger);
        Frontend::spawn(command)
    }

    fn attach(&self) -> Frontend {
        let mut command = Command::new(KEEPER);
        command.arg("attach").arg(&self.socket);
        Frontend::spawn(command)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = Command::new(KEEPER).arg("stop").arg(&self.socket).status();
        let _ = std::fs::remove_file(&self.trigger);
    }
}

struct Frontend {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Frontend {
    fn spawn(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Frontend { child, stdin, stdout }
    }

    fn send(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").unwrap();
    }

    fn line(&mut self) -> String {
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        line.trim_end().to_owned()
    }

    fn signal(&self, signal: i32) {
        unsafe { libc::kill(self.child.id() as i32, signal) };
    }

    fn status(mut self) -> std::process::ExitStatus {
        self.child.wait().unwrap()
    }
}

#[test]
fn passes_bytes_and_the_exit_code_through() {
    let session = Session::new();
    let mut frontend = session.launch("read line; echo \"got:$line\"; exit 7");
    frontend.send("hello");
    assert_eq!(frontend.line(), "got:hello");
    assert_eq!(frontend.status().code(), Some(7));
}

#[test]
fn holds_output_while_detached_and_replays_it_on_attach() {
    let session = Session::new();
    let script = "read line; echo \"now:$line\"; while [ ! -e \"$1\" ]; do sleep 0.02; done; echo \"held:$line\"; cat";
    let mut first = session.launch(script);
    first.send("one");
    assert_eq!(first.line(), "now:one");
    first.signal(libc::SIGUSR1);
    assert_eq!(first.status().code(), Some(75));

    // Output produced with nobody attached waits for the next server.
    std::fs::write(&session.trigger, b"").unwrap();
    let mut second = session.attach();
    assert_eq!(second.line(), "held:one");
    second.send("two");
    assert_eq!(second.line(), "two");
}

#[test]
fn delivers_an_exit_that_happened_while_detached() {
    let session = Session::new();
    let script = "echo up; read line; while [ ! -e \"$1\" ]; do sleep 0.02; done; echo \"bye:$line\"; exit 3";
    let mut first = session.launch(script);
    assert_eq!(first.line(), "up");
    first.send("x");
    first.signal(libc::SIGUSR1);
    assert_eq!(first.status().code(), Some(75));
    std::fs::write(&session.trigger, b"").unwrap();
    let mut second = session.attach();
    assert_eq!(second.line(), "bye:x");
    assert_eq!(second.status().code(), Some(3));
}

#[test]
fn a_terminate_request_ends_the_cli_with_that_signal() {
    let session = Session::new();
    let mut frontend = session.launch("echo started; exec sleep 600");
    assert_eq!(frontend.line(), "started");
    frontend.signal(libc::SIGTERM);
    assert_eq!(frontend.status().signal(), Some(libc::SIGTERM));
    assert_eq!(session.attach().status().code(), Some(125));
}

#[test]
fn stop_ends_a_session_nobody_will_reattach() {
    let session = Session::new();
    let mut frontend = session.launch("echo started; exec sleep 600");
    assert_eq!(frontend.line(), "started");
    frontend.signal(libc::SIGUSR1);
    assert_eq!(frontend.status().code(), Some(75));
    assert!(Command::new(KEEPER).arg("stop").arg(&session.socket).status().unwrap().success());
    assert_eq!(session.attach().status().code(), Some(125));
}
