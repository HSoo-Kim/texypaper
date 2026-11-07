use crate::{
    contracts::{AppError, AppResult, Environment},
    process::OwnedChild,
    ssh_askpass::AskpassBroker,
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    process::{ChildStdin, Command, Stdio},
    sync::{
        Arc, Condvar, LazyLock, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const HEADER_LIMIT: usize = 64 * 1024;
const PAYLOAD_LIMIT: usize = 1024 * 1024;
const MARKER: &[u8] = b"TEXYPAPER/1\n";
const WORKER: &[u8] = include_bytes!("../../resources/remote_worker.py");
static WORKER_SHA: LazyLock<String> = LazyLock::new(|| format!("{:x}", Sha256::digest(WORKER)));
// Neither root paths nor project text is interpolated into this fixed program.
const BOOTSTRAP: &str = r#"import sys,os,hashlib,tempfile,runpy
line=sys.stdin.buffer.readline(128)
parts=line.decode('ascii').strip().split(' ')
if len(parts)!=2: raise RuntimeError('invalid TexyPaper upload')
n=int(parts[0]); expected=parts[1]
if not 0<n<=1048576 or len(expected)!=64: raise RuntimeError('invalid TexyPaper upload bound')
source=bytearray()
while len(source)<n:
 chunk=sys.stdin.buffer.read(n-len(source))
 if not chunk: raise RuntimeError('truncated TexyPaper worker')
 source.extend(chunk)
if hashlib.sha256(source).hexdigest()!=expected: raise RuntimeError('TexyPaper worker digest mismatch')
base=os.path.expanduser('~/.cache/texypaper/worker')
os.makedirs(base,mode=0o700,exist_ok=True)
directory=os.path.join(base,expected)
os.makedirs(directory,mode=0o700,exist_ok=True)
os.chmod(directory,0o700)
path=os.path.join(directory,'remote_worker.py')
try:
 with open(path,'rb') as cached: reusable=hashlib.sha256(cached.read(1048577)).hexdigest()==expected
except FileNotFoundError:
 reusable=False
if not reusable:
 fd,temporary=tempfile.mkstemp(prefix='.upload-',dir=directory)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'wb') as target:
   target.write(source); target.flush(); os.fsync(target.fileno())
  os.replace(temporary,path)
 finally:
  if os.path.exists(temporary): os.unlink(temporary)
os.chmod(path,0o600)
if hashlib.sha256(open(path,'rb').read(1048577)).hexdigest()!=expected: raise RuntimeError('cached TexyPaper worker digest mismatch')
del source
runpy.run_path(path,run_name='__main__')
"#;

#[derive(Debug)]
struct Reply {
    result: Value,
    payload: Vec<u8>,
}
struct Pending {
    sender: mpsc::SyncSender<AppResult<Reply>>,
    deadline: Instant,
}
struct Inner {
    epoch: u64,
    next_id: AtomicU64,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<OwnedChild>,
    pending: Mutex<HashMap<u64, Pending>>,
    slots: Mutex<usize>,
    available: Condvar,
    closed: AtomicBool,
    handshake_complete: AtomicBool,
    started: Instant,
    error: Mutex<Option<AppError>>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    stderr_complete: Arc<AtomicBool>,
    broker: AskpassBroker,
}
#[derive(Clone)]
pub struct SshBackend {
    pub root: String,
    pub workspace_id: String,
    inner: Arc<Inner>,
}
impl SshBackend {
    pub fn connect(
        environment: &Environment,
        root: &str,
        workspace_id: &str,
        epoch: u64,
    ) -> AppResult<Self> {
        if environment.kind != "ssh"
            || root.is_empty()
            || root.contains('\0')
            || root.len() > 8192
            || workspace_id.is_empty()
        {
            return Err(AppError::new(
                "SSH_ENVIRONMENT_INVALID",
                "A selected SSH environment and a nonempty POSIX project root are required",
            ));
        }
        if WORKER.len() > PAYLOAD_LIMIT {
            return Err(AppError::new(
                "REMOTE_RUNTIME_UNAVAILABLE",
                "The bundled workspace worker exceeds the upload bound",
            ));
        }
        let broker = AskpassBroker::start()?;
        let mut command = ssh_command(environment)?;
        command.arg(format!("python3 -I -u -c {}", shell_quote(BOOTSTRAP)));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        broker.configure(&mut command)?;
        let mut child = OwnedChild::spawn(&mut command).map_err(|error| {
            AppError::new(
                "SSH_UNAVAILABLE",
                format!("Could not start native OpenSSH: {}", error.message),
            )
        })?;
        let stdin = child
            .child_mut()
            .stdin
            .take()
            .ok_or_else(|| protocol("SSH stdin is unavailable"))?;
        let stdout = child
            .child_mut()
            .stdout
            .take()
            .ok_or_else(|| protocol("SSH stdout is unavailable"))?;
        let mut stderr = child
            .child_mut()
            .stderr
            .take()
            .ok_or_else(|| protocol("SSH stderr is unavailable"))?;
        let tail = Arc::new(Mutex::new(VecDeque::with_capacity(64 * 1024)));
        let tail_writer = tail.clone();
        let stderr_complete = Arc::new(AtomicBool::new(false));
        let drained = stderr_complete.clone();
        thread::Builder::new()
            .name("ssh-stderr".into())
            .spawn(move || {
                let mut bytes = [0u8; 4096];
                while let Ok(count) = stderr.read(&mut bytes) {
                    if count == 0 {
                        break;
                    }
                    let mut tail = tail_writer.lock().unwrap_or_else(|e| e.into_inner());
                    let remove = (tail.len() + count).saturating_sub(64 * 1024);
                    tail.drain(..remove);
                    tail.extend(&bytes[..count]);
                }
                drained.store(true, Ordering::Release);
            })?;
        let inner = Arc::new(Inner {
            epoch,
            next_id: AtomicU64::new(1),
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            slots: Mutex::new(0),
            available: Condvar::new(),
            closed: AtomicBool::new(false),
            handshake_complete: AtomicBool::new(false),
            started: Instant::now(),
            error: Mutex::new(None),
            stderr: tail,
            stderr_complete,
            broker,
        });
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let weak = Arc::downgrade(&inner);
        thread::Builder::new()
            .name("ssh-worker-reader".into())
            .spawn(move || reader(stdout, weak, ready_sender))?;
        let weak = Arc::downgrade(&inner);
        thread::Builder::new()
            .name("ssh-worker-lifecycle".into())
            .spawn(move || monitor(weak))?;
        {
            let mut input = inner.stdin.lock().unwrap_or_else(|e| e.into_inner());
            let input = input.as_mut().ok_or_else(disconnected)?;
            if let Err(error) = (|| -> std::io::Result<()> {
                writeln!(input, "{} {}", WORKER.len(), *WORKER_SHA)?;
                input.write_all(WORKER)?;
                input.flush()
            })() {
                let error = inner.connection_error(&error.to_string(), false);
                inner.fail(error.clone());
                return Err(error);
            }
        }
        match ready_receiver.recv_timeout(Duration::from_secs(360)) {
            Ok(Ok(())) => {
                inner.handshake_complete.store(true, Ordering::Release);
            }
            Ok(Err(error)) => {
                inner.fail(error.clone());
                return Err(error);
            }
            Err(_) => {
                let error = inner.connection_error(
                    "Timed out waiting for Python workspace worker; Python >=3.9 is required",
                    true,
                );
                inner.fail(error.clone());
                return Err(error);
            }
        }
        let mut backend = Self {
            root: root.into(),
            workspace_id: workspace_id.into(),
            inner,
        };
        let hello = backend.execute("hello", json!({}))?;
        if hello
            .get("protocol")
            .and_then(Value::as_u64)
            .is_some_and(|version| version != 1)
        {
            backend
                .inner
                .fail(protocol("Remote worker protocol version is unsupported"));
            return Err(protocol("Remote worker protocol version is unsupported"));
        }
        let opened = backend.execute(
            "open_root",
            json!({"root":root,"workspaceId":workspace_id,"epoch":epoch}),
        )?;
        backend.root = opened
            .get("root")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with('/'))
            .ok_or_else(|| protocol("Worker did not return its canonical POSIX root"))?
            .into();
        let mut identity = Sha256::new();
        identity.update(environment.id.as_bytes());
        identity.update([0]);
        identity.update(backend.root.as_bytes());
        let stable_id = format!("{:x}", identity.finalize());
        backend.request(
            "open_root",
            json!({"root":backend.root,"workspaceId":stable_id,"epoch":epoch}),
        )?;
        backend.workspace_id = stable_id;
        Ok(backend)
    }
    pub fn execute(&self, op: &str, mut args: Value) -> AppResult<Value> {
        let agent_policy = args["_agentPolicy"].as_bool() == Some(true);
        if op == "read_range" {
            return Err(AppError::new(
                "BINARY_RANGE_REQUIRED",
                "Use the raw-byte range transport for binary reads",
            ));
        }
        if op == "asset_import_chunk" {
            let upload_id = args["uploadId"].clone();
            let outcome = (|| -> AppResult<Value> {
                let encoded = args
                    .as_object_mut()
                    .and_then(|object| object.remove("data"))
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .ok_or_else(|| {
                        AppError::new("ARGUMENT_INVALID", "Base64 asset data required")
                    })?;
                if encoded.len() > 256 * 1024 {
                    return Err(AppError::new(
                        "UPLOAD_CHUNK_LIMIT",
                        "Asset chunk exceeds 192 KiB",
                    ));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| AppError::new("ARGUMENT_INVALID", "Invalid base64 asset chunk"))?;
                // Binary bytes belong in the framed payload, never in the 64 KiB JSON header.
                Ok(self
                    .request_payload(op, args, std::borrow::Cow::Owned(bytes))?
                    .result)
            })();
            if outcome.is_err()
                && upload_id.is_string()
                && !self.inner.closed.load(Ordering::Acquire)
            {
                let _ = self.request("asset_import_abort", json!({"uploadId":upload_id}));
            }
            return outcome;
        }
        if op == "save_text"
            && args
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.len() > PAYLOAD_LIMIT)
        {
            let text = match args.as_object_mut().and_then(|args| args.remove("text")) {
                Some(Value::String(text)) => text,
                _ => return Err(protocol("Missing save text")),
            };
            if text.len() > 4 * PAYLOAD_LIMIT && args["allowLargeFile"].as_bool() != Some(true) {
                return Err(AppError::new(
                    "FILE_TOO_LARGE",
                    "Source files larger than 4 MiB require explicit conversion or external editing",
                ));
            }
            args["totalLength"] = json!(text.len());
            let started = self.request("save_text_begin", args)?.result;
            let upload = started["uploadId"]
                .as_str()
                .ok_or_else(|| protocol("Worker did not return a source upload ID"))?;
            let outcome = (|| -> AppResult<Value> {
                for (index, chunk) in text.as_bytes().chunks(PAYLOAD_LIMIT).enumerate() {
                    self.request_payload(
                        "save_text_chunk",
                        json!({"uploadId":upload,"offset":index * PAYLOAD_LIMIT}),
                        std::borrow::Cow::Borrowed(chunk),
                    )?;
                }
                Ok(self
                    .request("save_text_commit", json!({"uploadId":upload}))?
                    .result)
            })();
            if outcome.is_err() && !self.inner.closed.load(Ordering::Acquire) {
                let _ = self.request("save_text_abort", json!({"uploadId":upload}));
            }
            return outcome;
        }
        let mut reply = self.request(op, args)?;
        if op == "read_text" && reply.result["chunkedText"].as_bool() == Some(true) {
            let total = reply.result["textByteLength"]
                .as_u64()
                .filter(|size| *size <= 4 * PAYLOAD_LIMIT as u64)
                .ok_or_else(|| protocol("Chunked source exceeds the editable 4 MiB bound"))?
                as usize;
            let offset = reply.result["textOffset"]
                .as_u64()
                .filter(|offset| *offset == 0 || *offset == 3)
                .ok_or_else(|| protocol("Invalid source encoding offset"))?;
            let path = reply.result["file"]["path"]
                .as_str()
                .ok_or_else(|| protocol("Chunked text is missing its scoped file path"))?;
            if reply.payload.len() > total {
                return Err(protocol("Initial text chunk exceeds its declared size"));
            }
            reply.payload.reserve_exact(total - reply.payload.len());
            while reply.payload.len() < total {
                let chunk = self.read_bytes_scoped(
                    path,
                    offset + reply.payload.len() as u64,
                    (total - reply.payload.len()).min(PAYLOAD_LIMIT),
                    agent_policy,
                )?;
                if chunk.is_empty() {
                    return Err(AppError::new(
                        "FILE_CONFLICT",
                        "Remote source changed while its chunks were being read",
                    ));
                }
                reply.payload.extend_from_slice(&chunk);
            }
            let mut digest = Sha256::new();
            if offset == 3 {
                digest.update([0xef, 0xbb, 0xbf]);
            }
            digest.update(&reply.payload);
            if reply.result["revision"]["sha256"].as_str()
                != Some(format!("{:x}", digest.finalize()).as_str())
            {
                return Err(AppError::new(
                    "FILE_CONFLICT",
                    "Remote source changed while its chunks were being read",
                ));
            }
            let current = self
                .request(
                    "stat_many",
                    json!({"paths":[path],"hash":true,"_agentPolicy":agent_policy}),
                )?
                .result;
            if current["entries"][0]["revision"]["sha256"] != reply.result["revision"]["sha256"] {
                return Err(AppError::new(
                    "FILE_CONFLICT",
                    "Remote source changed before its read completed",
                ));
            }
            let text = String::from_utf8(std::mem::take(&mut reply.payload)).map_err(|_| {
                AppError::new("ENCODING_UNSUPPORTED", "Remote source is not valid UTF-8")
            })?;
            let metadata = reply
                .result
                .as_object_mut()
                .ok_or_else(|| protocol("Invalid source metadata"))?;
            for key in [
                "chunkedText",
                "textInPayload",
                "textByteLength",
                "textOffset",
            ] {
                metadata.remove(key);
            }
            metadata.insert("text".into(), Value::String(text));
        }
        if !reply.payload.is_empty() {
            return Err(protocol("Unexpected raw payload for a JSON operation"));
        }
        Ok(reply.result)
    }
    pub fn read_bytes(&self, path: &str, offset: u64, length: usize) -> AppResult<Vec<u8>> {
        self.read_bytes_scoped(path, offset, length, false)
    }
    fn read_bytes_scoped(
        &self,
        path: &str,
        offset: u64,
        length: usize,
        agent_policy: bool,
    ) -> AppResult<Vec<u8>> {
        validate_relative(path)?;
        if length == 0 || length > PAYLOAD_LIMIT || offset.checked_add(length as u64).is_none() {
            return Err(AppError::new(
                "RANGE_INVALID",
                "Byte ranges must contain 1..1048576 bytes",
            ));
        }
        let reply = self.request(
            "read_range",
            json!({"path":path,"offset":offset,"length":length,"_agentPolicy":agent_policy}),
        )?;
        if reply.payload.len() > length
            || reply.result["byteLength"].as_u64() != Some(reply.payload.len() as u64)
            || reply.result["offset"].as_u64() != Some(offset)
        {
            let error = protocol("Worker returned an inconsistent raw byte range");
            self.inner.fail(error.clone());
            return Err(error);
        }
        Ok(reply.payload)
    }
    pub fn close(&self) -> AppResult<()> {
        if !self.inner.closed.load(Ordering::Acquire) {
            let _ = self.request("close", json!({}));
        }
        self.inner.fail(disconnected());
        self.inner
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel()?;
        self.inner
            .stdin
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        Ok(())
    }
    fn request(&self, op: &str, args: Value) -> AppResult<Reply> {
        self.request_payload(op, args, std::borrow::Cow::Borrowed(&[]))
    }
    fn request_payload(
        &self,
        op: &str,
        mut args: Value,
        mut payload: std::borrow::Cow<'_, [u8]>,
    ) -> AppResult<Reply> {
        if op.is_empty() || op.len() > 64 || !args.is_object() {
            return Err(protocol("Invalid worker operation or arguments"));
        }
        // Paths are checked here and again against the remote canonical root.
        for key in ["path", "from", "to", "rootTex"] {
            if let Some(path) = args.get(key).and_then(Value::as_str) {
                validate_relative(path)?;
            }
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        if op == "save_text"
            && let Some(Value::String(text)) =
                args.as_object_mut().and_then(|args| args.remove("text"))
        {
            if text.len() > PAYLOAD_LIMIT {
                return Err(AppError::new(
                    "PROTOCOL_LIMIT",
                    "Remote save exceeds the 1 MiB frame bound",
                ));
            }
            payload = std::borrow::Cow::Owned(text.into_bytes());
        }
        let mut header = json!({"v":1,"id":id,"workspaceId":self.workspace_id,"epoch":self.inner.epoch,"op":op,"args":args});
        let encoded = match encode_json(&header, HEADER_LIMIT) {
            Ok(encoded) => encoded,
            Err(_) => {
                if !payload.is_empty() {
                    return Err(AppError::new(
                        "PROTOCOL_LIMIT",
                        "Remote request metadata exceeds 64 KiB",
                    ));
                }
                let maximum = if matches!(op, "apply_proposal" | "comments_update") {
                    8 * PAYLOAD_LIMIT
                } else {
                    PAYLOAD_LIMIT
                };
                payload = std::borrow::Cow::Owned(encode_json(&header["args"], maximum)?);
                if payload.len() > PAYLOAD_LIMIT {
                    let started = self
                        .request("args_begin", json!({"op":op,"totalLength":payload.len()}))?
                        .result;
                    let upload = started["uploadId"]
                        .as_str()
                        .ok_or_else(|| protocol("Worker did not return an argument upload ID"))?;
                    let outcome = (|| -> AppResult<Reply> {
                        for (index, chunk) in payload.chunks(PAYLOAD_LIMIT).enumerate() {
                            self.request_payload(
                                "args_chunk",
                                json!({"uploadId":upload,"offset":index * PAYLOAD_LIMIT}),
                                std::borrow::Cow::Borrowed(chunk),
                            )?;
                        }
                        self.request("args_execute", json!({"uploadId":upload}))
                    })();
                    if outcome.is_err() && !self.inner.closed.load(Ordering::Acquire) {
                        let _ = self.request("args_abort", json!({"uploadId":upload}));
                    }
                    return outcome;
                }
                header["args"] = json!({});
                header["argsInPayload"] = json!(true);
                encode_json(&header, HEADER_LIMIT)?
            }
        };
        if payload.len() > PAYLOAD_LIMIT {
            return Err(AppError::new(
                "PROTOCOL_LIMIT",
                "Remote request exceeds the bounded protocol",
            ));
        }
        let control = matches!(op, "build_cancel" | "command_cancel" | "close" | "ping");
        let maximum = if control { 8 } else { 7 };
        let timeout = if op == "build_start" {
            Duration::from_secs(180)
        } else if op == "close" {
            Duration::from_secs(5)
        } else if matches!(op, "command_start" | "command_status" | "command_cancel") {
            Duration::from_secs(15)
        } else {
            Duration::from_secs(90)
        };
        let deadline = Instant::now() + timeout;
        let mut slots = self.inner.slots.lock().unwrap_or_else(|e| e.into_inner());
        while *slots >= maximum && !self.inner.closed.load(Ordering::Acquire) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AppError::new(
                    "SSH_BUSY",
                    "The bounded remote request queue is full",
                ));
            }
            let (guard, _) = self
                .inner
                .available
                .wait_timeout(slots, remaining)
                .unwrap_or_else(|e| e.into_inner());
            slots = guard;
        }
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(self.inner.last_error());
        }
        *slots += 1;
        drop(slots);
        let _permit = Permit(&self.inner);
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = self.inner.pending.lock().unwrap_or_else(|e| e.into_inner());
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(self.inner.last_error());
            }
            pending.insert(id, Pending { sender, deadline });
        }
        let result = (|| -> AppResult<()> {
            let mut input = self.inner.stdin.lock().unwrap_or_else(|e| e.into_inner());
            let input = input.as_mut().ok_or_else(disconnected)?;
            input.write_all(&(encoded.len() as u32).to_be_bytes())?;
            input.write_all(&encoded)?;
            input.write_all(&(payload.len() as u32).to_be_bytes())?;
            input.write_all(&payload)?;
            input.flush()?;
            Ok(())
        })();
        if let Err(error) = result {
            let error = self.inner.connection_error(&error.message, false);
            self.inner.fail(error.clone());
            return Err(error);
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(reply) => reply,
            Err(_) => {
                let error = self.inner.connection_error("Remote operation timed out; mutations are not automatically replayed. Reconnect and query transaction status.", false);
                self.inner.fail(error.clone());
                Err(error)
            }
        }
    }
}
struct Permit<'a>(&'a Inner);
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut slots = self.0.slots.lock().unwrap_or_else(|e| e.into_inner());
        *slots = slots.saturating_sub(1);
        self.0.available.notify_all();
    }
}
impl Inner {
    fn last_error(&self) -> AppError {
        self.error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(disconnected)
    }
    fn fail(&self, error: AppError) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.broker.stop();
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error.clone());
        for (_, pending) in self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            let _ = pending.sender.try_send(Err(error.clone()));
        }
        self.available.notify_all();
    }
    fn connection_error(&self, fallback: &str, runtime: bool) -> AppError {
        let drain_deadline = Instant::now() + Duration::from_millis(250);
        while !self.stderr_complete.load(Ordering::Acquire) && Instant::now() < drain_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let bytes: Vec<u8> = self
            .stderr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect();
        let stderr = String::from_utf8_lossy(&bytes);
        let lower = stderr.to_ascii_lowercase();
        let code = if lower.contains("remote host identification has changed")
            || lower.contains("host key verification failed") && lower.contains("offending")
        {
            "SSH_HOST_KEY_CHANGED"
        } else if self.broker.cancelled().load(Ordering::Acquire) {
            "SSH_CANCELLED"
        } else if lower.contains("permission denied (")
            || lower.contains("authentication failed")
            || lower.contains("too many authentication failures")
        {
            "SSH_AUTH_FAILED"
        } else if [
            "could not resolve",
            "connection refused",
            "connection timed out",
            "no route to host",
            "connection reset",
            "connection closed",
        ]
        .iter()
        .any(|message| lower.contains(message))
        {
            "SSH_DISCONNECTED"
        } else if runtime
            || lower.contains("python3: not found")
            || lower.contains("python3: command not found")
            || lower.contains("no module named")
        {
            "REMOTE_RUNTIME_UNAVAILABLE"
        } else {
            "SSH_DISCONNECTED"
        };
        let mut error = AppError::new(
            code,
            if stderr.trim().is_empty() {
                fallback.into()
            } else {
                format!("{fallback}\n{}", stderr.trim())
            },
        );
        error.retryable = code == "SSH_DISCONNECTED";
        error
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self
            .child
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .cancel();
    }
}
fn monitor(weak: Weak<Inner>) {
    loop {
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let now = Instant::now();
        let handshake_expired = !inner.handshake_complete.load(Ordering::Acquire)
            && now.duration_since(inner.started) >= Duration::from_secs(360);
        let request_expired = inner
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|pending| pending.deadline <= now);
        if handshake_expired || request_expired {
            inner.fail(inner.connection_error("Remote operation deadline exceeded; uncertain mutations must be checked by transaction ID after reconnect", handshake_expired));
        }
        if inner.closed.load(Ordering::Acquire) || inner.broker.cancelled().load(Ordering::Acquire)
        {
            if !inner.closed.load(Ordering::Acquire) {
                inner.fail(AppError::new(
                    "SSH_CANCELLED",
                    "SSH authentication was cancelled",
                ));
            }
            let _ = inner
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cancel();
            return;
        }
        let status = inner
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait();
        if matches!(status, Ok(Some(_)) | Err(_)) {
            let _ = inner
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cancel();
            return;
        }
        drop(inner);
        thread::sleep(Duration::from_millis(100));
    }
}
fn reader(mut output: impl Read, weak: Weak<Inner>, ready: mpsc::SyncSender<AppResult<()>>) {
    if let Err(error) = handshake(&mut output) {
        if let Some(inner) = weak.upgrade() {
            let error = if error.code == "SSH_PROTOCOL_ERROR" {
                error
            } else {
                inner.connection_error(&error.message, true)
            };
            inner.fail(error.clone());
            let _ = ready.send(Err(error));
        }
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }
    loop {
        let response = read_reply(&mut output);
        let Some(inner) = weak.upgrade() else {
            return;
        };
        match response {
            Ok((id, reply)) => {
                let sender = inner
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                let Some(sender) = sender else {
                    inner.fail(protocol(
                        "Remote response has an unknown or repeated request ID",
                    ));
                    return;
                };
                let _ = sender.sender.try_send(reply);
            }
            Err(error) => {
                inner.fail(if error.code == "IO_ERROR" {
                    inner.connection_error(&error.message, false)
                } else {
                    error
                });
                return;
            }
        }
    }
}
fn handshake(output: &mut impl Read) -> AppResult<()> {
    let mut matched = 0usize;
    for position in 0..(8192 + MARKER.len()) {
        let mut byte = [0];
        output.read_exact(&mut byte)?;
        if byte[0] == MARKER[matched] {
            matched += 1;
        } else {
            matched = usize::from(byte[0] == MARKER[0]);
        }
        if matched == MARKER.len() {
            if position + 1 - MARKER.len() <= 8192 {
                return Ok(());
            }
            break;
        }
    }
    Err(protocol(
        "Login-banner preamble exceeds 8 KiB or TEXYPAPER/1 marker is missing",
    ))
}
fn read_reply(output: &mut impl Read) -> AppResult<(u64, AppResult<Reply>)> {
    let mut bytes = [0; 4];
    output.read_exact(&mut bytes)?;
    let length = u32::from_be_bytes(bytes) as usize;
    if length == 0 || length > HEADER_LIMIT {
        return Err(protocol("Worker header exceeds 64 KiB"));
    }
    let mut header = vec![0; length];
    output.read_exact(&mut header)?;
    let header: Value = serde_json::from_slice(&header)
        .map_err(|e| protocol(&format!("Invalid worker JSON: {e}")))?;
    output.read_exact(&mut bytes)?;
    let length = u32::from_be_bytes(bytes) as usize;
    if length > PAYLOAD_LIMIT {
        return Err(protocol("Worker payload exceeds 1 MiB"));
    }
    let mut payload = vec![0; length];
    output.read_exact(&mut payload)?;
    if header["v"].as_u64() != Some(1) {
        return Err(protocol("Unsupported remote protocol version"));
    }
    let id = header["id"]
        .as_u64()
        .ok_or_else(|| protocol("Worker response is missing its integer request ID"))?;
    if header["ok"].as_bool() == Some(false) {
        let encoded = if header["error"]["errorInPayload"].as_bool() == Some(true) {
            serde_json::from_slice(&payload)
                .map_err(|e| protocol(&format!("Invalid error payload: {e}")))?
        } else {
            header["error"].clone()
        };
        let error = serde_json::from_value::<AppError>(encoded)
            .map_err(|e| protocol(&format!("Invalid worker error: {e}")))?;
        return Ok((id, Err(error)));
    }
    if header["ok"].as_bool() != Some(true) {
        return Err(protocol(
            "Worker response is missing its success discriminator",
        ));
    }
    let mut result = header
        .get("result")
        .cloned()
        .ok_or_else(|| protocol("Worker response is missing its result"))?;
    if result["resultInPayload"].as_bool() == Some(true) {
        result = serde_json::from_slice(&payload)
            .map_err(|e| protocol(&format!("Invalid JSON result payload: {e}")))?;
        payload.clear();
    } else if result["textInPayload"].as_bool() == Some(true)
        && result["chunkedText"].as_bool() != Some(true)
    {
        let text = String::from_utf8(std::mem::take(&mut payload))
            .map_err(|_| protocol("Worker returned non-UTF8 text payload"))?;
        result
            .as_object_mut()
            .ok_or_else(|| protocol("Text metadata is not an object"))?
            .remove("textInPayload");
        result["text"] = json!(text);
    }
    Ok((id, Ok(Reply { result, payload })))
}
fn ssh_command(environment: &Environment) -> AppResult<Command> {
    let destination = environment
        .host_alias
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(environment.hostname.as_deref())
        .ok_or_else(|| {
            AppError::new(
                "SSH_ENVIRONMENT_INVALID",
                "An SSH alias or hostname is required",
            )
        })?;
    if destination.starts_with('-')
        || destination.is_empty()
        || destination.len() > 1024
        || !destination
            .chars()
            .all(|c| c.is_alphanumeric() || "._-@:%[]+".contains(c))
    {
        return Err(AppError::new(
            "SSH_ENVIRONMENT_INVALID",
            "The SSH destination is not a literal alias or hostname",
        ));
    }
    #[cfg(windows)]
    let program = std::env::var_os("WINDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("C:\\Windows"))
        .join("System32/OpenSSH/ssh.exe");
    #[cfg(not(windows))]
    let program = std::path::PathBuf::from("ssh");
    let mut command = Command::new(program);
    command.arg("-T");
    for option in [
        "ServerAliveInterval=15",
        "ServerAliveCountMax=2",
        "ConnectTimeout=10",
        "StrictHostKeyChecking=ask",
        "UpdateHostKeys=no",
        "ForwardAgent=no",
        "PermitLocalCommand=no",
    ] {
        command.args(["-o", option]);
    }
    if let Some(config) = &environment.ssh_config_file {
        if config.contains('\0') {
            return Err(protocol("Invalid SSH config path"));
        }
        command.arg("-F").arg(config);
    }
    if let Some(user) = &environment.user {
        if user.is_empty()
            || user.starts_with('-')
            || user.len() > 256
            || !user
                .chars()
                .all(|c| c.is_alphanumeric() || "._-@+".contains(c))
        {
            return Err(AppError::new(
                "SSH_ENVIRONMENT_INVALID",
                "The SSH user must be a literal username without command separators or controls",
            ));
        }
        command.arg("-l").arg(user);
    }
    if let Some(port) = environment.port {
        if port == 0 {
            return Err(protocol("Invalid SSH port"));
        }
        command.arg("-p").arg(port.to_string());
    }
    if let Some(identity) = &environment.identity_file {
        if identity.contains('\0') {
            return Err(protocol("Invalid SSH identity path"));
        }
        command.arg("-i").arg(identity);
    }
    command.arg("--").arg(destination);
    Ok(command)
}
fn validate_relative(path: &str) -> AppResult<()> {
    if path.contains(['\0', '\\', ':'])
        || path.starts_with('/')
        || path.split('/').any(|part| part == "..")
    {
        return Err(AppError::new(
            "PATH_INVALID",
            "Workspace paths must be relative POSIX paths without traversal",
        ));
    }
    Ok(())
}
fn encode_json(value: &Value, limit: usize) -> AppResult<Vec<u8>> {
    struct Buffer {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "JSON frame exceeds its bound",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut buffer = Buffer {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut buffer, value)
        .map_err(|error| AppError::new("PROTOCOL_LIMIT", error.to_string()))?;
    Ok(buffer.bytes)
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn protocol(message: &str) -> AppError {
    AppError::new("SSH_PROTOCOL_ERROR", message)
}
fn disconnected() -> AppError {
    let mut error = AppError::new(
        "SSH_DISCONNECTED",
        "The persistent SSH workspace connection is closed",
    );
    error.retryable = true;
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    struct Fragmented(Cursor<Vec<u8>>);
    impl Read for Fragmented {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            let length = output.len().min(1);
            self.0.read(&mut output[..length])
        }
    }
    fn frame(header: Value, payload: &[u8]) -> Vec<u8> {
        let encoded = serde_json::to_vec(&header).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&encoded);
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }
    #[test]
    fn fragmented_binary_range_preserves_every_byte() {
        let raw = b"\x00\xff\x80PDF\r\n";
        let bytes = frame(
            json!({"v":1,"id":42,"ok":true,"result":{"offset":8,"byteLength":raw.len()}}),
            raw,
        );
        let (id, reply) = read_reply(&mut Fragmented(Cursor::new(bytes))).unwrap();
        assert_eq!(id, 42);
        assert_eq!(reply.unwrap().payload.as_slice(), raw.as_slice());
    }
    #[test]
    fn oversized_header_is_rejected_before_reading_or_allocating_it() {
        let bytes = ((HEADER_LIMIT + 1) as u32).to_be_bytes().to_vec();
        let error = read_reply(&mut Fragmented(Cursor::new(bytes))).unwrap_err();
        assert_eq!(error.code, "SSH_PROTOCOL_ERROR");
    }
    #[test]
    fn oversized_payload_is_rejected_before_reading_it() {
        let header = serde_json::to_vec(&json!({"v":1,"id":1,"ok":true,"result":{}})).unwrap();
        let mut bytes = (header.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&((PAYLOAD_LIMIT + 1) as u32).to_be_bytes());
        assert_eq!(
            read_reply(&mut Fragmented(Cursor::new(bytes)))
                .unwrap_err()
                .code,
            "SSH_PROTOCOL_ERROR"
        );
    }
    #[test]
    fn fragmented_banner_accepts_exact_preamble_limit() {
        let mut bytes = vec![b'x'; 8192];
        bytes.extend_from_slice(MARKER);
        handshake(&mut Fragmented(Cursor::new(bytes))).unwrap();
        let mut bytes = vec![b'x'; 8193];
        bytes.extend_from_slice(MARKER);
        assert_eq!(
            handshake(&mut Fragmented(Cursor::new(bytes)))
                .unwrap_err()
                .code,
            "SSH_PROTOCOL_ERROR"
        );
    }
    #[test]
    fn fragmented_text_and_error_payloads_decode_without_binary_json_arrays() {
        let text = "한글 e\u{301} 😀";
        let bytes = frame(
            json!({"v":1,"id":7,"ok":true,"result":{"textInPayload":true}}),
            text.as_bytes(),
        );
        let (_, reply) = read_reply(&mut Fragmented(Cursor::new(bytes))).unwrap();
        let reply = reply.unwrap();
        assert_eq!(reply.result["text"], text);
        assert!(reply.payload.is_empty());
        let error = json!({"code":"BUILD_FAILED","message":"real compiler failure","retryable":false,"details":{"logTail":"diagnostic"}});
        let bytes = frame(
            json!({"v":1,"id":8,"ok":false,"error":{"errorInPayload":true}}),
            &serde_json::to_vec(&error).unwrap(),
        );
        let (_, reply) = read_reply(&mut Fragmented(Cursor::new(bytes))).unwrap();
        assert_eq!(reply.unwrap_err().details.unwrap()["logTail"], "diagnostic");
    }
    #[test]
    fn paths_reject_traversal_drives_unc_and_alternate_streams() {
        for path in [
            "../a",
            "dir/../a",
            "/etc/passwd",
            "C:/a",
            "\\\\host\\file",
            "a:stream",
        ] {
            assert!(validate_relative(path).is_err());
        }
        assert!(validate_relative("논문/section.tex").is_ok());
    }
    #[test]
    fn serialization_limits_count_escaped_wire_bytes() {
        let value = json!({"text":"\\\"".repeat(HEADER_LIMIT)});
        assert_eq!(
            encode_json(&value, HEADER_LIMIT).unwrap_err().code,
            "PROTOCOL_LIMIT"
        );
        assert!(encode_json(&value, PAYLOAD_LIMIT).is_ok());
    }
    #[test]
    fn native_ssh_rejects_option_and_command_injection_without_spawning() {
        for destination in [
            "-oProxyCommand=bad",
            "host;bad",
            "host\nbad",
            "host\u{1}bad",
            "host bad",
        ] {
            let environment: Environment = serde_json::from_value(
                json!({"id":"test","label":"test","kind":"ssh","hostAlias":destination}),
            )
            .unwrap();
            assert!(ssh_command(&environment).is_err());
        }
        let environment: Environment = serde_json::from_value(json!({"id":"test","label":"test","kind":"ssh","hostAlias":"paper-server","user":"user;bad"})).unwrap();
        assert!(ssh_command(&environment).is_err());
    }
}
