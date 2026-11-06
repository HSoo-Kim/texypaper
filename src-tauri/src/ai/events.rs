use crate::contracts::{AppError, AppEvent, AppResult, WorkspaceRef};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
};

pub const MAX_FRAME: usize = 1024 * 1024;
pub type Emit = Arc<dyn Fn(AppEvent) + Send + Sync>;
#[derive(Clone)]
pub struct Events {
    workspace: WorkspaceRef,
    sequence: Arc<AtomicU64>,
    emit: Emit,
    history: PathBuf,
    lock: Arc<Mutex<()>>,
    task_id: Option<String>,
    provider: Option<String>,
}
impl Events {
    pub fn new(workspace: WorkspaceRef, emit: Emit, data: &Path) -> Self {
        Self {
            history: data
                .join("workspaces")
                .join(&workspace.id)
                .join("agent-history"),
            workspace,
            sequence: Arc::new(AtomicU64::new(1)),
            emit,
            lock: Arc::new(Mutex::new(())),
            task_id: None,
            provider: None,
        }
    }
    pub fn with_task(mut self, id: &str, provider: &str) -> Self {
        self.task_id = Some(id.into());
        self.provider = Some(provider.into());
        self
    }
    pub fn send(&self, kind: &str, mut payload: Value) {
        if let Some(object) = payload.as_object_mut() {
            if let Some(id) = &self.task_id {
                object.entry("taskId").or_insert_with(|| json!(id));
            }
            if let Some(provider) = &self.provider {
                object.entry("provider").or_insert_with(|| json!(provider));
            }
        }
        let event = AppEvent {
            workspace_id: self.workspace.id.clone(),
            epoch: self.workspace.epoch,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            kind: kind.into(),
            payload,
        };
        // Command snapshots remain in the bounded execution runtime only; journaling
        // repeated full stdout/stderr would defeat its retention bound.
        if !matches!(
            kind,
            "agent/login"
                | "build/published"
                | "proposal/created"
                | "command/updated"
                | "command/permission"
        ) && let Ok(_lock) = self.lock.lock()
            && fs::create_dir_all(&self.history).is_ok()
        {
            let page = self.history.join("current.jsonl");
            if fs::metadata(&page)
                .map(|m| m.len() >= 1024 * 1024)
                .unwrap_or(false)
            {
                let _ = fs::rename(
                    &page,
                    self.history.join(format!("{}.jsonl", uuid::Uuid::new_v4())),
                );
            }
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(page)
                && let Ok(mut bytes) = serde_json::to_vec(&event)
            {
                bytes.push(b'\n');
                let _ = f.write_all(&bytes);
            }
        }
        (self.emit)(event);
    }
    pub fn error(&self, error: &AppError) {
        self.send("agent/error", json!({"error":error,"status":"failed"}));
    }
}
pub fn read_bounded_line<R: BufRead>(reader: &mut R, max: usize) -> AppResult<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(AppError::new(
                    "PROVIDER_PROTOCOL_ERROR",
                    "Provider ended with an incomplete JSON line",
                ))
            };
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        if line.len() + count > max {
            return Err(AppError::new(
                "PROVIDER_PROTOCOL_ERROR",
                "Provider JSON line exceeds 1 MiB",
            ));
        }
        let done = available[count - 1] == b'\n';
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if done {
            return Ok(Some(line));
        }
    }
}
pub fn json_reader<R: Read + Send + 'static>(input: R) -> Receiver<AppResult<Value>> {
    let (tx, rx) = mpsc::sync_channel(8);
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(input);
        loop {
            match read_bounded_line(&mut reader, MAX_FRAME) {
                Ok(Some(line)) => {
                    let value = serde_json::from_slice(&line)
                        .map_err(|e| AppError::new("PROVIDER_PROTOCOL_ERROR", e.to_string()));
                    let failed = value.is_err();
                    if tx.send(value).is_err() || failed {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Err(e));
                    break;
                }
            }
        }
    });
    rx
}
pub fn drain_stderr<R: Read + Send + 'static>(mut input: R) -> Arc<Mutex<Vec<u8>>> {
    let tail = Arc::new(Mutex::new(Vec::new()));
    let copy = tail.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = input.read(&mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(mut bytes) = copy.lock() {
                let overflow = (bytes.len() + n).saturating_sub(65536);
                if overflow > 0 {
                    bytes.drain(..overflow);
                }
                bytes.extend_from_slice(&buf[..n]);
            }
        }
    });
    tail
}
pub fn history(data: &Path, workspace: &str, args: &Value) -> AppResult<Value> {
    let dir = data
        .join("workspaces")
        .join(workspace)
        .join("agent-history");
    if !dir.exists() {
        return Ok(json!({"events":[],"pages":[]}));
    }
    let mut pages = fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|v| v.to_str()) == Some("jsonl"))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    pages.sort();
    let page = args["page"].as_str().unwrap_or("current.jsonl");
    if !pages.iter().any(|p| p == page) {
        return Err(AppError::new(
            "HISTORY_PAGE_MISSING",
            "History page does not exist",
        ));
    }
    let mut events = std::collections::VecDeque::new();
    let mut size = 0;
    let mut reader = std::io::BufReader::new(fs::File::open(dir.join(page))?);
    while let Some(bytes) = read_bounded_line(&mut reader, MAX_FRAME)? {
        let event: Value = serde_json::from_slice(&bytes)?;
        size += bytes.len();
        events.push_back((event, bytes.len()));
        while events.len() > 1000 || size > 2 * 1024 * 1024 {
            if let Some((_, n)) = events.pop_front() {
                size -= n;
            }
        }
    }
    Ok(
        json!({"events":events.into_iter().map(|(v,_)|v).collect::<Vec<_>>(),"pages":pages,"page":page}),
    )
}
type WriteRequest = (Vec<u8>, std::sync::mpsc::SyncSender<AppResult<()>>);
pub struct JsonWriter {
    sender: std::sync::mpsc::SyncSender<WriteRequest>,
}
impl JsonWriter {
    pub fn new(mut writer: impl Write + Send + 'static) -> Self {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<WriteRequest>(1);
        thread::spawn(move || {
            while let Ok((bytes, ack)) = receiver.recv() {
                let result = writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .map_err(AppError::from);
                let failed = result.is_err();
                let _ = ack.send(result);
                if failed {
                    break;
                }
            }
        });
        Self { sender }
    }
    pub fn send(
        &self,
        value: &Value,
        deadline: std::time::Instant,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> AppResult<()> {
        let mut bytes = serde_json::to_vec(value)?;
        if bytes.len() + 1 > MAX_FRAME {
            return Err(AppError::new(
                "PROVIDER_INPUT_LIMIT",
                "Provider input exceeds 1 MiB",
            ));
        }
        bytes.push(b'\n');
        let (ack, done) = std::sync::mpsc::sync_channel(1);
        let mut pending = (bytes, ack);
        loop {
            check_write_deadline(deadline, cancel)?;
            match self.sender.try_send(pending) {
                Ok(()) => break,
                Err(std::sync::mpsc::TrySendError::Full(request)) => {
                    pending = request;
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    return Err(AppError::new("PROVIDER_EXITED", "Provider stdin closed"));
                }
            }
        }
        loop {
            check_write_deadline(deadline, cancel)?;
            match done.recv_timeout(std::time::Duration::from_millis(25)) {
                Ok(result) => return result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(AppError::new(
                        "PROVIDER_EXITED",
                        "Provider input writer closed",
                    ));
                }
            }
        }
    }
}
fn check_write_deadline(
    deadline: std::time::Instant,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err(AppError::new(
            "AGENT_CANCELLED",
            "Task cancelled while sending provider input",
        ));
    }
    if std::time::Instant::now() > deadline {
        return Err(AppError::new(
            "PROVIDER_TIMEOUT",
            "Provider stopped reading its bounded input",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_snapshots_emit_without_creating_persistent_history() {
        let directory = tempfile::tempdir().unwrap();
        let workspace: WorkspaceRef = serde_json::from_value(json!({
            "id":"command-history", "epoch":1, "environmentId":"local", "root":"/fixture",
        }))
        .unwrap();
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let received = delivered.clone();
        let events = Events::new(
            workspace,
            Arc::new(move |event| {
                received.lock().unwrap().push(event);
            }),
            directory.path(),
        );
        events.send(
            "command/updated",
            json!({"id":"actual","status":"completed","stdout":"actual output","exitCode":0}),
        );
        events.send("command/permission", json!({"permission":"session"}));
        assert_eq!(delivered.lock().unwrap().len(), 2);
        assert!(
            !directory
                .path()
                .join("workspaces/command-history/agent-history")
                .exists()
        );
        events.send("agent/text", json!({"delta":"Still retained"}));
        let history = history(directory.path(), "command-history", &json!({})).unwrap();
        let stored = history["events"].as_array().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["kind"], "agent/text");
    }
}
