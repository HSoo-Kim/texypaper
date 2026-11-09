pub mod local;
pub mod ssh;
pub mod ssh_config;
pub mod transactions;

use crate::contracts::{AppError, AppEvent, AppResult, Environment, WorkspaceRef};
use notify::Watcher;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, LazyLock, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
type ChangeHandler = Arc<dyn Fn(AppEvent) + Send + Sync>;
static CHANGE_HANDLER: LazyLock<RwLock<Option<ChangeHandler>>> =
    LazyLock::new(|| RwLock::new(None));
static CHANGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub fn set_change_handler(handler: ChangeHandler) {
    if let Ok(mut current) = CHANGE_HANDLER.write() {
        *current = Some(handler);
    }
}
fn watch(
    root: &std::path::Path,
    reference: &WorkspaceRef,
    data_dir: PathBuf,
    index: Arc<Mutex<()>>,
) -> AppResult<notify::RecommendedWatcher> {
    let watched_root = root.to_path_buf();
    let identity = reference.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let paths = event
            .paths
            .iter()
            .filter_map(|path| path.strip_prefix(&watched_root).ok())
            .filter_map(|path| {
                let path = path.to_string_lossy().replace('\\', "/");
                if path.split('/').any(|part| {
                    part.starts_with(".texypaper-")
                        || part.starts_with(".paperdock-") // Legacy private temporary files.
                        || matches!(
                            part,
                            ".git"
                                | ".texypaper"
                                | ".paperdock" // Legacy private metadata.
                                | "node_modules"
                                | ".venv"
                                | "venv"
                                | "__pycache__"
                        )
                }) {
                    None
                } else {
                    Some(path)
                }
            })
            .take(256)
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return;
        }
        if let Ok(_guard) = index.lock() {
            let _ = local::invalidate_paths(&watched_root, &data_dir, &paths);
        }
        let handler = CHANGE_HANDLER
            .read()
            .ok()
            .and_then(|handler| handler.clone());
        if let Some(handler) = handler {
            handler(AppEvent {
                workspace_id: identity.id.clone(),
                epoch: identity.epoch,
                sequence: CHANGE_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
                kind: "workspace/changed".into(),
                payload: json!({"paths":paths}),
            });
        }
    })
    .map_err(|error| AppError::new("WATCH_UNAVAILABLE", error.to_string()))?;
    watcher
        .watch(root, notify::RecursiveMode::Recursive)
        .map_err(|error| AppError::new("WATCH_UNAVAILABLE", error.to_string()))?;
    Ok(watcher)
}

#[derive(Clone)]
pub struct Workspace {
    pub reference: WorkspaceRef,
    inner: Arc<WorkspaceInner>,
}
struct WorkspaceInner {
    index: Arc<Mutex<()>>,
    backend: Backend,
    mutations: Mutex<()>,
    closed: AtomicBool,
    data_dir: PathBuf,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}
enum Backend {
    Local(PathBuf),
    Ssh(ssh::SshBackend),
}
pub struct WorkspaceManager {
    data_dir: PathBuf,
    active: Option<Workspace>,
    epoch: u64,
}
impl WorkspaceManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            active: None,
            epoch: 0,
        }
    }
    pub fn open(&mut self, environment: Environment, root: String) -> AppResult<WorkspaceRef> {
        if self.active.is_some() {
            return Err(AppError::new(
                "WORKSPACE_ACTIVE",
                "Close the current workspace before opening another.",
            ));
        }
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| AppError::new("EPOCH_OVERFLOW", "Workspace epoch exhausted"))?;
        let root = if environment.kind == "local" {
            std::fs::canonicalize(root)?.to_string_lossy().into_owned()
        } else {
            root
        };
        let mut id = local::hash(format!("{}\0{}", environment.id, root).as_bytes());
        let (backend, root) = match environment.kind.as_str() {
            "local" => {
                let root = std::fs::canonicalize(root)?;
                if !root.is_dir() {
                    return Err(AppError::new(
                        "NOT_DIRECTORY",
                        "Project root must be a directory",
                    ));
                }
                crate::migration::migrate_project(&root)?;
                let label = root.to_string_lossy().into_owned();
                (Backend::Local(root), label)
            }
            "ssh" => {
                let remote = ssh::SshBackend::connect(&environment, &root, &id, self.epoch)?;
                id = remote.workspace_id.clone();
                let canonical_root = remote.root.clone();
                (Backend::Ssh(remote), canonical_root)
            }
            _ => {
                return Err(AppError::new(
                    "ENVIRONMENT_INVALID",
                    "Unknown environment kind",
                ));
            }
        };
        let reference = WorkspaceRef {
            id,
            environment_id: environment.id,
            root,
            epoch: self.epoch,
        };
        let index = Arc::new(Mutex::new(()));
        if let Backend::Local(root) = &backend {
            local::reopen_scan(root, &self.data_dir)?;
        }
        let watcher = match &backend {
            Backend::Local(root) => Some(watch(
                root,
                &reference,
                self.data_dir.clone(),
                index.clone(),
            )?),
            Backend::Ssh(_) => None,
        };
        self.active = Some(Workspace {
            reference: reference.clone(),
            inner: Arc::new(WorkspaceInner {
                backend,
                mutations: Mutex::new(()),
                index,
                closed: AtomicBool::new(false),
                data_dir: self.data_dir.clone(),
                watcher: Mutex::new(watcher),
            }),
        });
        Ok(reference)
    }
    pub fn close(&mut self) -> AppResult<()> {
        if let Some(workspace) = self.active.take() {
            workspace.inner.closed.store(true, Ordering::Release);
            crate::execution::cancel_workspace(&workspace.reference.id, workspace.reference.epoch)?;
            let _mutation_guard = workspace.inner.mutations.lock().map_err(|_| {
                AppError::new(
                    "WORKSPACE_LOCK",
                    "Workspace mutation lock failed while closing",
                )
            })?;
            if let Ok(mut watcher) = workspace.inner.watcher.lock() {
                watcher.take();
            }
            match &workspace.inner.backend {
                Backend::Local(root) => {
                    local::abort_asset_uploads(root, &workspace.reference.id);
                    let _ = crate::latex::local_execute(root, "build_cancel", json!({}));
                }
                Backend::Ssh(remote) => remote.close()?,
            }
        }
        Ok(())
    }
    pub fn active(&self, workspace_id: &str, epoch: u64) -> AppResult<Workspace> {
        self.active
            .as_ref()
            .filter(|w| {
                w.reference.id == workspace_id
                    && w.reference.epoch == epoch
                    && !w.inner.closed.load(Ordering::Acquire)
            })
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "WORKSPACE_STALE",
                    "Workspace is closed or its epoch changed",
                )
            })
    }
}
impl Workspace {
    pub(crate) fn ensure_open(&self) -> AppResult<()> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(AppError::new(
                "WORKSPACE_STALE",
                "Workspace is closed or its epoch changed",
            ));
        }
        Ok(())
    }
    pub(crate) fn command_remote(&self) -> Option<ssh::SshBackend> {
        match &self.inner.backend {
            Backend::Ssh(remote) => Some(remote.clone()),
            Backend::Local(_) => None,
        }
    }
    pub(crate) fn ssh_disconnected(&self) -> bool {
        matches!(&self.inner.backend, Backend::Ssh(remote) if remote.is_disconnected())
    }

    pub fn local_root(&self) -> Option<PathBuf> {
        match &self.inner.backend {
            Backend::Local(root) => Some(root.clone()),
            Backend::Ssh(_) => None,
        }
    }
    pub fn data_dir(&self) -> PathBuf {
        self.inner.data_dir.clone()
    }
    pub fn execute(&self, op: &str, mut args: Value) -> AppResult<Value> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(AppError::new("WORKSPACE_STALE", "Workspace is closed"));
        }
        if !args.is_object() {
            args = json!({});
        }
        args["workspaceId"] = json!(self.reference.id);
        args["epoch"] = json!(self.reference.epoch);
        let mutation = matches!(
            op,
            "save_text"
                | "create"
                | "rename"
                | "trash"
                | "restore"
                | "apply_proposal"
                | "undo_transaction"
                | "comments_update"
                | "project_update"
                | "asset_import_begin"
                | "asset_import_chunk"
                | "asset_import_commit"
                | "asset_import_abort"
        );
        let _guard =
            if mutation {
                Some(self.inner.mutations.lock().map_err(|_| {
                    AppError::new("WORKSPACE_LOCK", "Workspace mutation lock failed")
                })?)
            } else {
                None
            };
        let _index_guard = if matches!(
            op,
            "list_dir"
                | "scan_step"
                | "create"
                | "rename"
                | "trash"
                | "restore"
                | "asset_import_commit"
        ) {
            Some(
                self.inner
                    .index
                    .lock()
                    .map_err(|_| AppError::new("INDEX_LOCK", "Workspace index lock failed"))?,
            )
        } else {
            None
        };
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(AppError::new(
                "WORKSPACE_STALE",
                "Workspace was closed while the operation was queued",
            ));
        }
        match &self.inner.backend {
            Backend::Ssh(remote) => {
                if op == "build_start" {
                    args["projectTrusted"] =
                        json!(args["_projectTrusted"].as_bool().unwrap_or(false));
                }
                remote.execute(op, args)
            }
            Backend::Local(root) => {
                local::execute(root, &self.reference.id, &self.inner.data_dir, op, args)
            }
        }
    }
    pub fn read_bytes(&self, path: &str, offset: u64, length: usize) -> AppResult<Vec<u8>> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(AppError::new("WORKSPACE_STALE", "Workspace is closed"));
        }
        if length > 1024 * 1024 {
            return Err(AppError::new("RANGE_TOO_LARGE", "Read range exceeds 1 MiB"));
        }
        match &self.inner.backend {
            Backend::Local(root) => local::read_bytes(root, path, offset, length),
            Backend::Ssh(remote) => remote.read_bytes(path, offset, length),
        }
    }
}
