use crate::contracts::{AppError, AppResult};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

const LIMIT: usize = 16 * 1024;
type Handler = Arc<dyn Fn(Value) + Send + Sync>;
type Answer = Option<String>;
static HANDLER: LazyLock<Mutex<Option<Handler>>> = LazyLock::new(|| Mutex::new(None));
static PROMPTS: LazyLock<Mutex<HashMap<String, mpsc::SyncSender<Answer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn pending() -> &'static Mutex<HashMap<String, mpsc::SyncSender<Answer>>> {
    &PROMPTS
}
pub fn set_prompt_handler(handler: Handler) {
    *HANDLER.lock().unwrap_or_else(|e| e.into_inner()) = Some(handler);
}
pub fn answer_prompt(id: &str, answer: Option<String>) -> AppResult<()> {
    if answer
        .as_ref()
        .is_some_and(|s| s.len() > LIMIT / 2 || s.contains(['\0', '\n', '\r']))
    {
        return Err(AppError::new(
            "SSH_PROMPT_INVALID",
            "The SSH answer exceeds the limit or contains a line break",
        ));
    }
    let sender = pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id)
        .ok_or_else(|| {
            AppError::new("SSH_PROMPT_EXPIRED", "This SSH prompt has already expired")
        })?;
    sender
        .send(answer)
        .map_err(|_| AppError::new("SSH_PROMPT_EXPIRED", "This SSH connection has closed"))
}
struct State {
    token: String,
    stopped: AtomicBool,
    cancelled: Arc<AtomicBool>,
    active: AtomicUsize,
    seen: Mutex<HashSet<String>>,
    prompts: Mutex<HashSet<String>>,
}
pub struct AskpassBroker {
    state: Arc<State>,
    address: String,
}
impl AskpassBroker {
    pub fn start() -> AppResult<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?.to_string();
        listener.set_nonblocking(true)?;
        let state = Arc::new(State {
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            stopped: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            active: AtomicUsize::new(0),
            seen: Mutex::new(HashSet::new()),
            prompts: Mutex::new(HashSet::new()),
        });
        let weak = Arc::downgrade(&state);
        thread::Builder::new()
            .name("ssh-askpass-listener".into())
            .spawn(move || {
                while let Some(state) = weak.upgrade() {
                    if state.stopped.load(Ordering::Acquire) {
                        break;
                    }
                    match listener.accept() {
                        Ok((stream, address)) if address.ip().is_loopback() => {
                            if state.active.fetch_add(1, Ordering::AcqRel) >= 4 {
                                state.active.fetch_sub(1, Ordering::AcqRel);
                                continue;
                            }
                            let fallback = state.clone();
                            if thread::Builder::new()
                                .name("ssh-askpass-prompt".into())
                                .spawn(move || {
                                    let _ = handle(stream, &state);
                                    state.active.fetch_sub(1, Ordering::AcqRel);
                                })
                                .is_err()
                            {
                                fallback.active.fetch_sub(1, Ordering::AcqRel);
                            }
                        }
                        Ok(_) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(50))
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(Self { state, address })
    }
    pub fn configure(&self, command: &mut Command) -> AppResult<()> {
        command
            .env("SSH_ASKPASS", std::env::current_exe()?)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("TEXYPAPER_ASKPASS_ADDRESS", &self.address)
            .env("TEXYPAPER_ASKPASS_TOKEN", &self.state.token)
            .env(
                "DISPLAY",
                std::env::var_os("DISPLAY").unwrap_or_else(|| "texypaper:0".into()),
            );
        Ok(())
    }
    pub fn cancelled(&self) -> Arc<AtomicBool> {
        self.state.cancelled.clone()
    }
    pub(crate) fn stop(&self) {
        self.state.stopped.store(true, Ordering::Release);
        let ids = self.state.prompts.lock().unwrap_or_else(|e| e.into_inner());
        let mut pending = pending().lock().unwrap_or_else(|e| e.into_inner());
        for id in ids.iter() {
            if let Some(sender) = pending.remove(id) {
                let _ = sender.try_send(None);
            }
        }
    }
}
impl Drop for AskpassBroker {
    fn drop(&mut self) {
        self.stop();
    }
}
fn handle(mut stream: TcpStream, state: &State) -> AppResult<()> {
    // Authentication frames use blocking reads with bounded deadlines.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let request = receive(&mut stream)?;
    let token = request["token"].as_str().unwrap_or_default();
    // Compare every byte, without early-exit on a matching prefix.
    let mut mismatch = token.len() ^ state.token.len();
    for (left, right) in token.bytes().zip(state.token.bytes()) {
        mismatch |= (left ^ right) as usize;
    }
    if mismatch != 0 || state.stopped.load(Ordering::Acquire) {
        return Err(AppError::new(
            "SSH_PROMPT_AUTH",
            "Invalid askpass capability",
        ));
    }
    let nonce = request["nonce"]
        .as_str()
        .filter(|s| s.len() == 36)
        .ok_or_else(|| AppError::new("SSH_PROMPT_AUTH", "Missing askpass nonce"))?;
    {
        let mut seen = state.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() >= 64 || !seen.insert(nonce.to_string()) {
            return Err(AppError::new(
                "SSH_PROMPT_AUTH",
                "Askpass capability limit or replay",
            ));
        }
    }
    let prompt = request["prompt"]
        .as_str()
        .filter(|s| s.len() <= LIMIT / 2)
        .ok_or_else(|| {
            AppError::new("SSH_PROMPT_INVALID", "SSH prompt exceeds the bounded limit")
        })?;
    let handler = HANDLER.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(handler) = handler else {
        send(&mut stream, &json!({"answer":null}))?;
        state.cancelled.store(true, Ordering::Release);
        return Ok(());
    };
    let id = Uuid::new_v4().to_string();
    let lower = prompt.to_ascii_lowercase();
    let kind = if lower.contains("authenticity")
        || lower.contains("fingerprint")
        || lower.contains("continue connecting")
    {
        "hostKey"
    } else if lower.contains("passphrase") {
        "passphrase"
    } else if lower.contains("password") {
        "password"
    } else {
        "challenge"
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    {
        let mut ids = state.prompts.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped.load(Ordering::Acquire) {
            return Err(AppError::new("SSH_CANCELLED", "SSH connection has closed"));
        }
        pending()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), sender);
        ids.insert(id.clone());
    }
    handler(json!({"id":id,"prompt":prompt,"kind":kind}));
    let answer = receiver
        .recv_timeout(Duration::from_secs(300))
        .ok()
        .flatten();
    state
        .prompts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if answer.is_none() {
        state.cancelled.store(true, Ordering::Release);
    }
    send(&mut stream, &json!({"answer":answer}))
}
fn send(stream: &mut TcpStream, value: &Value) -> AppResult<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > LIMIT {
        return Err(AppError::new(
            "SSH_PROMPT_INVALID",
            "Askpass message is too large",
        ));
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}
fn receive(stream: &mut TcpStream) -> AppResult<Value> {
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let length = u32::from_be_bytes(size) as usize;
    if length == 0 || length > LIMIT {
        return Err(AppError::new(
            "SSH_PROMPT_INVALID",
            "Askpass frame exceeds the limit",
        ));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
/// OpenSSH invokes SSH_ASKPASS with the native prompt as argv[1], not with
/// application flags. The environment discriminator is checked before Tauri.
pub fn ssh_askpass_main() -> AppResult<()> {
    let address = std::env::var("TEXYPAPER_ASKPASS_ADDRESS")
        .map_err(|_| AppError::new("SSH_PROMPT_AUTH", "Missing askpass broker"))?;
    let address: std::net::SocketAddr = address
        .parse()
        .map_err(|_| AppError::new("SSH_PROMPT_AUTH", "Invalid askpass broker"))?;
    if !address.ip().is_loopback() {
        return Err(AppError::new(
            "SSH_PROMPT_AUTH",
            "Askpass broker must be loopback",
        ));
    }
    let token = std::env::var("TEXYPAPER_ASKPASS_TOKEN")
        .map_err(|_| AppError::new("SSH_PROMPT_AUTH", "Missing askpass capability"))?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let prompt = if args.first().map(String::as_str) == Some("--ssh-askpass") {
        args.get(1)
    } else {
        args.first()
    }
    .cloned()
    .unwrap_or_default();
    if prompt.len() > LIMIT / 2 {
        return Err(AppError::new(
            "SSH_PROMPT_INVALID",
            "SSH prompt exceeds the limit",
        ));
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(310)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    send(
        &mut stream,
        &json!({"token":token,"nonce":Uuid::new_v4().to_string(),"prompt":prompt}),
    )?;
    let response = receive(&mut stream)?;
    let answer = response["answer"]
        .as_str()
        .ok_or_else(|| AppError::new("SSH_CANCELLED", "SSH authentication was cancelled"))?;
    if answer.contains(['\n', '\r', '\0']) || answer.len() > LIMIT / 2 {
        return Err(AppError::new(
            "SSH_PROMPT_INVALID",
            "Invalid askpass answer",
        ));
    }
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(answer.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
