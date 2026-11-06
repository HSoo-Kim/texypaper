use super::{events::MAX_FRAME, tools::TexyPaperTools};
use crate::contracts::{AppError, AppResult};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

pub const BROKER_DOMAIN: &str = "texypaper.mcp.v1";
pub fn read_frame<R: Read>(reader: &mut R) -> AppResult<Value> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(AppError::new(
            "BROKER_FRAME_LIMIT",
            "Broker frame must be 1 byte–1 MiB",
        ));
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn write_frame<W: Write>(writer: &mut W, value: &Value) -> AppResult<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME {
        return Err(AppError::new(
            "BROKER_FRAME_LIMIT",
            "Broker reply exceeds 1 MiB",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}
fn constant_time_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes()
        .iter()
        .zip(b.as_bytes())
        .fold(0u8, |n, (a, b)| n | (a ^ b))
        == 0
}
#[derive(Clone)]
pub struct BrokerEnvironment {
    pub address: String,
    pub capability: String,
    pub task_id: String,
}
pub struct Broker {
    pub environment: BrokerEnvironment,
    active: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
}
impl Broker {
    pub fn start(tools: Arc<TexyPaperTools>, task_id: String) -> AppResult<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let token = rand::random::<[u8; 32]>();
        let capability = token.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let environment = BrokerEnvironment {
            address: listener.local_addr()?.to_string(),
            capability,
            task_id,
        };
        let active = Arc::new(AtomicBool::new(true));
        let live = active.clone();
        let env = environment.clone();
        let connections = Arc::new(AtomicUsize::new(0));
        let retained_connections = connections.clone();
        thread::spawn(move || {
            while live.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, address)) => {
                        if !address.ip().is_loopback() {
                            continue;
                        }
                        if connections.fetch_add(1, Ordering::AcqRel) >= 8 {
                            connections.fetch_sub(1, Ordering::AcqRel);
                            continue;
                        }
                        let tools = tools.clone();
                        let live = live.clone();
                        let env = env.clone();
                        let count = connections.clone();
                        thread::spawn(move || {
                            let _ = handle_client(&mut socket, &env, &tools, &live);
                            count.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            environment,
            active,
            connections: retained_connections,
        })
    }
    pub fn expire(&self) {
        self.active.store(false, Ordering::Release);
        while self.connections.load(Ordering::Acquire) > 0 {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.expire();
    }
}
fn handle_client(
    socket: &mut TcpStream,
    env: &BrokerEnvironment,
    tools: &TexyPaperTools,
    active: &AtomicBool,
) -> AppResult<()> {
    // Windows accepted sockets inherit the listener's nonblocking mode.
    socket.set_nonblocking(false)?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.set_write_timeout(Some(Duration::from_secs(10)))?;
    socket.set_nodelay(true)?;
    let handshake = read_frame(socket)?;
    if !active.load(Ordering::Acquire)
        || handshake["domain"] != BROKER_DOMAIN
        || handshake["taskId"] != env.task_id
        || !constant_time_equal(
            handshake["capability"].as_str().unwrap_or(""),
            &env.capability,
        )
    {
        return Err(AppError::new(
            "BROKER_UNAUTHORIZED",
            "Invalid, expired or cross-task capability",
        ));
    }
    write_frame(
        socket,
        &json!({"ok":true,"workspaceId":tools.workspace.reference.id,"epoch":tools.workspace.reference.epoch}),
    )?;
    let mut sequence = 1u64;
    while active.load(Ordering::Acquire) {
        // Poll only socket readiness so expiry releases idle bridge connections without consuming partial frames.
        let mut ready = [0u8; 1];
        match socket.peek(&mut ready) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        }
        let request = read_frame(socket)?;
        if request["sequence"].as_u64() != Some(sequence) {
            return Err(AppError::new(
                "BROKER_REPLAY",
                "Request sequence is replayed/out of order",
            ));
        }
        sequence += 1;
        if !active.load(Ordering::Acquire) {
            break;
        }
        let tool = request["tool"].as_str().unwrap_or("");
        let result = tools.call(tool, request.get("args").cloned().unwrap_or(json!({})));
        if !active.load(Ordering::Acquire) {
            return Err(AppError::new(
                "BROKER_EXPIRED",
                "Task capability expired during request",
            ));
        }
        let response = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        write_frame(socket, &response)?;
    }
    Ok(())
}
#[derive(Clone)]
pub struct BridgeClient {
    environment: BrokerEnvironment,
    connection: Arc<Mutex<Option<(TcpStream, u64)>>>,
}
impl BridgeClient {
    pub fn from_environment() -> AppResult<Self> {
        let address = std::env::var("TEXYPAPER_BROKER_ADDR").map_err(|_| {
            AppError::new(
                "BROKER_UNAUTHORIZED",
                "Bridge requires an app-owned broker capability",
            )
        })?;
        let parsed: SocketAddr = address
            .parse()
            .map_err(|_| AppError::new("BROKER_UNAUTHORIZED", "Invalid broker address"))?;
        if !parsed.ip().is_loopback() || !parsed.is_ipv4() {
            return Err(AppError::new(
                "BROKER_UNAUTHORIZED",
                "Broker must be IPv4 loopback",
            ));
        }
        let capability = std::env::var("TEXYPAPER_BROKER_CAPABILITY")
            .map_err(|_| AppError::new("BROKER_UNAUTHORIZED", "Missing bridge capability"))?;
        if capability.len() != 64 || !capability.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::new("BROKER_UNAUTHORIZED", "Invalid capability"));
        }
        let task_id = std::env::var("TEXYPAPER_TASK_ID")
            .map_err(|_| AppError::new("BROKER_UNAUTHORIZED", "Missing task identity"))?;
        Ok(Self {
            environment: BrokerEnvironment {
                address,
                capability,
                task_id,
            },
            connection: Arc::new(Mutex::new(None)),
        })
    }
    pub fn call(&self, tool: &str, args: Value) -> AppResult<Value> {
        let mut state = self
            .connection
            .lock()
            .map_err(|_| AppError::new("BROKER_CLOSED", "Bridge lock failed"))?;
        if state.is_none() {
            let mut socket = TcpStream::connect(&self.environment.address)?;
            socket.set_read_timeout(Some(Duration::from_secs(120)))?;
            socket.set_write_timeout(Some(Duration::from_secs(10)))?;
            write_frame(
                &mut socket,
                &json!({"domain":BROKER_DOMAIN,"taskId":self.environment.task_id,"capability":self.environment.capability}),
            )?;
            let hello = read_frame(&mut socket)?;
            if hello["ok"] != true {
                return Err(AppError::new(
                    "BROKER_UNAUTHORIZED",
                    "Broker refused the bridge",
                ));
            }
            *state = Some((socket, 1));
        }
        let (socket, sequence) = state
            .as_mut()
            .ok_or_else(|| AppError::new("BROKER_CLOSED", "Bridge unavailable"))?;
        write_frame(
            socket,
            &json!({"sequence":sequence,"tool":tool,"args":args}),
        )?;
        *sequence += 1;
        let response = match read_frame(socket) {
            Ok(v) => v,
            Err(e) => {
                *state = None;
                return Err(e);
            }
        };
        if response["ok"] == true {
            Ok(response["result"].clone())
        } else {
            Err(serde_json::from_value(response["error"].clone())?)
        }
    }
}
