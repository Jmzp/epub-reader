// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::ipc::Response;

/// The .epub passed on the command line (double-click via the file association).
fn opened_path() -> Option<PathBuf> {
    std::env::args_os().skip(1).map(PathBuf::from).find(|p| {
        p.extension().is_some_and(|e| e.eq_ignore_ascii_case("epub")) && p.is_file()
    })
}

#[tauri::command]
fn opened_file_name() -> Option<String> {
    opened_path().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
}

/// Raw bytes (no JSON encoding) so large books cross the IPC boundary quickly.
#[tauri::command]
fn opened_file_bytes() -> Result<Response, String> {
    let path = opened_path().ok_or("no file was opened")?;
    std::fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![opened_file_name, opened_file_bytes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
