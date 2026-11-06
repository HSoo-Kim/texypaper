use crate::contracts::AppResult;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    sync::{LazyLock, Mutex},
};

static OWNED: LazyLock<Mutex<HashMap<u32, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn register_process(pid: u32, executable: &OsStr) {
    let name = std::path::Path::new(executable)
        .file_stem()
        .unwrap_or(executable)
        .to_string_lossy()
        .to_ascii_lowercase();
    let category = if name.contains("ssh") {
        "transport"
    } else if [
        "latex",
        "tex",
        "biber",
        "bibtex",
        "synctex",
        "tectonic",
        "makeindex",
    ]
    .iter()
    .any(|part| name.contains(part))
    {
        "compiler"
    } else {
        "agent"
    };
    OWNED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(pid, category.into());
}
pub fn unregister_process(pid: u32) {
    OWNED.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
}
struct Process {
    id: u32,
    parent: u32,
    name: String,
}
struct Memory {
    private_working: Option<u64>,
    private_commit: Option<u64>,
    working: u64,
    error: Option<String>,
}

/// Samples actual OS process counters. Missing access/counters remain null, never
/// zero: an incomplete measurement cannot certify the application RAM target.
pub fn snapshot() -> AppResult<Value> {
    let processes = platform::processes()?;
    let parents: HashMap<u32, u32> = processes.iter().map(|p| (p.id, p.parent)).collect();
    let owned = OWNED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let app = std::process::id();
    let mut rows = Vec::new();
    let mut totals: HashMap<&str, u64> =
        HashMap::from([("app", 0), ("transport", 0), ("compiler", 0), ("agent", 0)]);
    let mut incomplete = !processes.iter().any(|process| process.id == app);
    for process in processes {
        let mut cursor = process.id;
        let mut seen = HashSet::new();
        let mut category = None;
        while seen.insert(cursor) && seen.len() <= 128 {
            if let Some(group) = owned.get(&cursor) {
                category = Some(group.as_str());
                break;
            }
            if cursor == app {
                category = Some("app");
                break;
            }
            match parents.get(&cursor) {
                Some(parent) if *parent != 0 => cursor = *parent,
                _ => break,
            }
        }
        let Some(category) = category else {
            continue;
        };
        let memory = platform::memory(process.id);
        if let Some(bytes) = memory.private_working {
            *totals.entry(category).or_default() += bytes;
        } else {
            incomplete = true;
        }
        rows.push(json!({"pid":process.id,"parentPid":process.parent,"name":process.name,"category":category,
            "workingSetBytes":memory.working,"privateWorkingSetBytes":memory.private_working,"privateCommitBytes":memory.private_commit,"measurementError":memory.error}));
    }
    rows.sort_by_key(|row| row["pid"].as_u64().unwrap_or(0));
    let budget = 300u64 * 1024 * 1024;
    let total: u64 = totals.values().sum();
    Ok(
        json!({"sampledAtMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        "appPrivateWorkingSetBytes":totals["app"],"transportPrivateWorkingSetBytes":totals["transport"],
        "compilerPrivateWorkingSetBytes":totals["compiler"],"agentPrivateWorkingSetBytes":totals["agent"],
        "totalPrivateWorkingSetBytes":total,"appBudgetBytes":budget,"complete":!incomplete,
        "withinBudget":if incomplete { Value::Null } else { json!(totals["app"] <= budget) },"processes":rows}),
    )
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        name: [u16; 260],
    }
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        size: u32,
        faults: u32,
        peak_working: usize,
        working: usize,
        peak_paged: usize,
        paged: usize,
        peak_nonpaged: usize,
        nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn K32GetProcessMemoryInfo(process: Handle, counters: *mut Counters, size: u32) -> i32;
        fn K32QueryWorkingSet(process: Handle, buffer: *mut c_void, size: u32) -> i32;
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub fn processes() -> AppResult<Vec<Process>> {
        let handle = unsafe { CreateToolhelp32Snapshot(2, 0) };
        if handle as isize == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        let handle = OwnedHandle(handle);
        let mut entry: Entry = unsafe { std::mem::zeroed() };
        entry.size = std::mem::size_of::<Entry>() as u32;
        let mut result = Vec::new();
        let mut found = unsafe { Process32FirstW(handle.0, &mut entry) } != 0;
        if !found {
            return Err(std::io::Error::last_os_error().into());
        }
        while found {
            let length = entry
                .name
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.name.len());
            result.push(Process {
                id: entry.pid,
                parent: entry.parent,
                name: String::from_utf16_lossy(&entry.name[..length]),
            });
            found = unsafe { Process32NextW(handle.0, &mut entry) } != 0;
        }
        Ok(result)
    }
    pub fn memory(pid: u32) -> Memory {
        let handle = unsafe { OpenProcess(0x0400 | 0x0010, 0, pid) };
        if handle.is_null() {
            return Memory {
                private_working: None,
                private_commit: None,
                working: 0,
                error: Some(std::io::Error::last_os_error().to_string()),
            };
        }
        let handle = OwnedHandle(handle);
        let mut counters = Counters {
            size: std::mem::size_of::<Counters>() as u32,
            ..Counters::default()
        };
        if unsafe {
            K32GetProcessMemoryInfo(
                handle.0,
                &mut counters,
                std::mem::size_of::<Counters>() as u32,
            )
        } == 0
        {
            return Memory {
                private_working: None,
                private_commit: None,
                working: 0,
                error: Some(std::io::Error::last_os_error().to_string()),
            };
        }
        let mut count = (counters.working / 4096)
            .saturating_add(1024)
            .min(2 * 1024 * 1024);
        for _ in 0..3 {
            let mut buffer = vec![0usize; count + 1];
            if unsafe {
                K32QueryWorkingSet(
                    handle.0,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * std::mem::size_of::<usize>()) as u32,
                )
            } != 0
            {
                let entries = buffer[0];
                if entries <= count {
                    let private = buffer[1..1 + entries]
                        .iter()
                        .filter(|flags| (**flags & (1 << 8)) == 0)
                        .count() as u64
                        * 4096;
                    return Memory {
                        private_working: Some(private),
                        private_commit: Some(counters.private as u64),
                        working: counters.working as u64,
                        error: None,
                    };
                }
            }
            count = count.saturating_mul(2).min(2 * 1024 * 1024);
        }
        Memory {
            private_working: None,
            private_commit: Some(counters.private as u64),
            working: counters.working as u64,
            error: Some(
                "Private working-set query exceeded its bounded snapshot or process exited".into(),
            ),
        }
    }
}
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;
    pub fn processes() -> AppResult<Vec<Process>> {
        let mut result = Vec::new();
        for entry in fs::read_dir("/proc")? {
            let entry = entry?;
            let Ok(id) = entry.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let Some(open) = stat.find('(') else {
                continue;
            };
            let Some(close) = stat.rfind(')') else {
                continue;
            };
            let parent = stat[close + 1..]
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            result.push(Process {
                id,
                parent,
                name: stat[open + 1..close].into(),
            });
        }
        Ok(result)
    }
    pub fn memory(pid: u32) -> Memory {
        match fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) {
            Ok(text) => {
                let mut private = 0;
                let mut working = 0;
                for line in text.lines() {
                    let mut words = line.split_whitespace();
                    let key = words.next().unwrap_or_default();
                    let bytes = words
                        .next()
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(0)
                        * 1024;
                    if matches!(
                        key,
                        "Private_Clean:" | "Private_Dirty:" | "Private_Hugetlb:"
                    ) {
                        private += bytes;
                    }
                    if key == "Rss:" {
                        working = bytes;
                    }
                }
                Memory {
                    private_working: Some(private),
                    private_commit: None,
                    working,
                    error: None,
                }
            }
            Err(error) => Memory {
                private_working: None,
                private_commit: None,
                working: 0,
                error: Some(error.to_string()),
            },
        }
    }
}
#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::*;
    pub fn processes() -> AppResult<Vec<Process>> {
        Err(crate::contracts::AppError::new(
            "RESOURCE_METRICS_UNAVAILABLE",
            "Private working-set accounting is supported on Windows and Linux",
        ))
    }
    pub fn memory(_: u32) -> Memory {
        unreachable!()
    }
}
