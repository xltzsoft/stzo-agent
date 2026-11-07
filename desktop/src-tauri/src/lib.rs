// STZO Agent desktop shell.
//
// The UI talks to the bundled Node runtime that runs the stzo CLI:
//   * long-lived `stzo --mode rpc` per open project (pi RPC protocol over JSON lines)
//   * short-lived `stzo desktop-api <method>` calls for account, shop, sessions, plugins
// Processes are spawned here (not through the shell plugin) so stdout is framed strictly on LF,
// as the RPC protocol requires, and no console window flashes on Windows.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct Procs {
    next: AtomicU64,
    stdin: Mutex<HashMap<u64, ChildStdin>>,
    children: Mutex<HashMap<u64, Arc<Mutex<Child>>>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ProcEvent {
    Stdout { id: u64, line: String },
    Stderr { id: u64, line: String },
    Exit { id: u64, code: Option<i32> },
}

#[derive(Serialize)]
struct Env {
    platform: &'static str,
    home: String,
    cli: String,
    node: String,
    dev: bool,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
}

/// Bundled Node (externalBin lands next to the main executable), else STZO_NODE, else `node` on PATH.
fn node_path() -> PathBuf {
    if let Ok(p) = std::env::var("STZO_NODE") {
        return PathBuf::from(p);
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = exe_dir().join(name);
    if bundled.exists() {
        return bundled;
    }
    PathBuf::from(name)
}

/// Bundled app resources, else STZO_CLI, else the repo checkout (dev).
fn cli_path(app: &AppHandle) -> (PathBuf, bool) {
    if let Ok(p) = std::env::var("STZO_CLI") {
        return (PathBuf::from(p), true);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("app").join("bin").join("stzo.js");
        if p.exists() {
            return (p, false);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bin/stzo.js");
    (dev, true)
}

/// GUI apps on macOS start with a minimal PATH; borrow the login shell's so git, npm, etc. resolve.
fn user_path() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if !cfg!(target_os = "macos") {
                return None;
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let mut child = Command::new(shell)
                .args(["-ilc", "printf '__STZO_PATH__%s' \"$PATH\""])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            // A slow or interactive shell profile must not hold up the agent: give it 3 seconds,
            // then fall back to the inherited PATH.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(30)),
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                }
            }
            let mut out = Vec::new();
            child.stdout.take()?.read_to_end(&mut out).ok()?;
            let s = String::from_utf8_lossy(&out);
            let p = s.rsplit("__STZO_PATH__").next()?.trim().to_string();
            if p.is_empty() {
                None
            } else {
                Some(p)
            }
        })
        .clone()
}

fn spawn_reader<R: Read + Send + 'static>(app: AppHandle, id: u64, stream: R, err: bool) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::with_capacity(8192);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if buf.ends_with(b"\n") {
                        buf.pop();
                    }
                    if buf.ends_with(b"\r") {
                        buf.pop();
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    let ev = if err { ProcEvent::Stderr { id, line } } else { ProcEvent::Stdout { id, line } };
                    let _ = app.emit("proc", ev);
                }
            }
        }
    })
}

#[tauri::command]
fn app_env(app: AppHandle) -> Env {
    let (cli, dev) = cli_path(&app);
    Env {
        platform: std::env::consts::OS,
        home: app.path().home_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        cli: cli.display().to_string(),
        node: node_path().display().to_string(),
        dev,
    }
}

/// Start `node <cli> <args…>` in `cwd`. Output arrives as `proc` events.
/// Async so the PATH probe and process start never block the UI thread.
#[tauri::command(async)]
fn proc_spawn(app: AppHandle, procs: State<'_, Procs>, args: Vec<String>, cwd: Option<String>) -> Result<u64, String> {
    let (cli, _) = cli_path(&app);
    let mut cmd = Command::new(node_path());
    cmd.arg("--no-warnings")
        .arg(&cli)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("STZO_DESKTOP", "1")
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1");
    if let Some(p) = user_path() {
        cmd.env("PATH", p);
    }
    let cwd_checked = cwd.filter(|d| !d.is_empty());
    if let Some(dir) = cwd_checked.as_ref() {
        cmd.current_dir(dir);
    } else if let Ok(home) = app.path().home_dir() {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Some(dir) = cwd_checked.as_ref() {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("项目文件夹不存在：{dir}"));
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法启动内置运行时：{e}"))?;
    let id = procs.next.fetch_add(1, Ordering::SeqCst) + 1;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    if let Some(stdin) = child.stdin.take() {
        procs.stdin.lock().unwrap().insert(id, stdin);
    }
    let readers = [spawn_reader(app.clone(), id, stdout, false), spawn_reader(app.clone(), id, stderr, true)];
    let child = Arc::new(Mutex::new(child));
    procs.children.lock().unwrap().insert(id, child.clone());

    let waiter_app = app.clone();
    std::thread::spawn(move || {
        let code = loop {
            if let Ok(Some(status)) = child.lock().unwrap().try_wait() {
                break status.code();
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        };
        let procs = waiter_app.state::<Procs>();
        procs.stdin.lock().unwrap().remove(&id);
        procs.children.lock().unwrap().remove(&id);
        // Report exit only after the last output lines were delivered. Bounded, because a grandchild
        // that inherited the pipes (e.g. a background dev server) can keep them open.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while readers.iter().any(|h| !h.is_finished()) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = waiter_app.emit("proc", ProcEvent::Exit { id, code });
    });
    Ok(id)
}

#[tauri::command(async)]
fn proc_write(procs: State<'_, Procs>, id: u64, line: String) -> Result<(), String> {
    let mut map = procs.stdin.lock().unwrap();
    let stdin = map.get_mut(&id).ok_or("进程已退出")?;
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    if !line.ends_with('\n') {
        stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    stdin.flush().map_err(|e| e.to_string())
}

/// Close stdin (orderly shutdown for RPC), then kill after a grace period.
#[tauri::command]
fn proc_kill(procs: State<'_, Procs>, id: u64, grace_ms: Option<u64>) {
    procs.stdin.lock().unwrap().remove(&id);
    let child = procs.children.lock().unwrap().get(&id).cloned();
    if let Some(child) = child {
        let grace = grace_ms.unwrap_or(0);
        std::thread::spawn(move || {
            if grace > 0 {
                std::thread::sleep(std::time::Duration::from_millis(grace));
            }
            // SIGTERM first so pi can stop the tools it started, then force.
            #[cfg(unix)]
            {
                let pid = child.lock().unwrap().id();
                if let Ok(None) = child.lock().unwrap().try_wait() {
                    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
                    for _ in 0..20 {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        if let Ok(Some(_)) = child.lock().unwrap().try_wait() {
                            return;
                        }
                    }
                }
            }
            let mut c = child.lock().unwrap();
            if let Ok(None) = c.try_wait() {
                let _ = c.kill();
            }
        });
    }
}

fn kill_all(app: &AppHandle) {
    let procs = app.state::<Procs>();
    procs.stdin.lock().unwrap().clear();
    for (_, child) in procs.children.lock().unwrap().drain() {
        let _ = child.lock().unwrap().kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Procs::default())
        .setup(|_| {
            // Warm the login-shell PATH probe in the background so the first agent starts fast.
            std::thread::spawn(|| {
                let _ = user_path();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_env, proc_spawn, proc_write, proc_kill])
        .build(tauri::generate_context!())
        .expect("error while building STZO Agent")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_all(app);
            }
        });
}
