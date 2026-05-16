use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

struct WorkerProcess(Mutex<Option<Child>>);

#[tauri::command]
fn app_ready() -> &'static str {
    "gongwen-writer-ready"
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("无法初始化更新器：{error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
    }))
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|error| format!("无法初始化更新器：{error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
        .ok_or_else(|| "当前已是最新版本".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("安装更新失败：{error}"))?;
    app.restart();
}

#[tauri::command]
fn save_download_file(app: tauri::AppHandle, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let download_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("无法定位下载目录：{error}"))?;
    fs::create_dir_all(&download_dir).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let safe_name = sanitize_file_name(&file_name);
    let path = unique_download_path(download_dir, &safe_name);
    fs::write(&path, bytes).map_err(|error| format!("保存文件失败：{error}"))?;
    Ok(path.display().to_string())
}

#[derive(Clone, serde::Serialize)]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: String,
}

fn sanitize_file_name(file_name: &str) -> String {
    let cleaned: String = file_name
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "公文材料.md".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn unique_download_path(download_dir: PathBuf, safe_name: &str) -> PathBuf {
    let mut path = download_dir.join(safe_name);
    if !path.exists() {
        return path;
    }
    let source = PathBuf::from(safe_name);
    let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("公文材料");
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("");
    for index in 1..1000 {
        let candidate = if extension.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        path = download_dir.join(candidate);
        if !path.exists() {
            return path;
        }
    }
    download_dir.join(safe_name)
}

fn start_worker(app: &tauri::App) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录：{error}"))?;
    let runtime_dir = [
        resource_dir.join("worker-runtime"),
        resource_dir.join("_up_/worker-runtime"),
    ]
    .into_iter()
    .find(|path| path.exists())
    .ok_or_else(|| format!("内置 worker-runtime 不存在：{}", resource_dir.display()))?;
    let node_path = {
        let windows = runtime_dir.join("node").join("node.exe");
        let posix = runtime_dir.join("node/bin/node");
        if windows.exists() { windows } else { posix }
    };
    let script_path = runtime_dir.join("app/server/index.mjs");
    let app_dir = runtime_dir.join("app");

    if !node_path.exists() {
        return Err(format!("内置 Node 运行时不存在：{}", node_path.display()));
    }
    if !script_path.exists() {
        return Err(format!("worker 入口不存在：{}", script_path.display()));
    }

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("无法定位日志目录：{error}"))?;
    fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建日志目录：{error}"))?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("worker.out.log"))
        .map_err(|error| format!("无法创建 worker stdout 日志：{error}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("worker.err.log"))
        .map_err(|error| format!("无法创建 worker stderr 日志：{error}"))?;

    let mut cmd = Command::new(node_path);
    cmd.arg(script_path)
        .current_dir(app_dir)
        .env("PORT", "8787")
        .env("GONGWEN_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let child = cmd.spawn()
        .map_err(|error| format!("无法启动本地 worker：{error}"))?;

    *app.state::<WorkerProcess>().0.lock().map_err(|_| "worker 状态锁异常".to_string())? =
        Some(child);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(WorkerProcess(Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Err(error) = start_worker(app) {
                eprintln!("{error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_ready, check_for_updates, install_update, save_download_file])
        .build(tauri::generate_context!())
        .expect("error while building gongwen writer")
        .run(|app_handle, event| {
            match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window(&label) {
                        let _ = window.hide();
                    }
                }
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                RunEvent::ExitRequested { .. } => {
                    if let Ok(mut child_slot) = app_handle.state::<WorkerProcess>().0.lock() {
                        if let Some(mut child) = child_slot.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
                _ => {}
            }
        });
}
