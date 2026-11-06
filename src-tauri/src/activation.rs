//! Restore-only Windows activation. The exclusive profile lock remains authoritative.
//! No paths, commands, workspace requests, or credentials travel over this channel.
use crate::contracts::AppResult;
use std::path::Path;

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::contracts::AppError;
    use sha2::{Digest, Sha256};
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        sync::{Arc, Mutex},
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use windows::{
        Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0},
            Security::{
                ACL, ACL_REVISION, AddAccessAllowedAce, GetLengthSid, GetTokenInformation,
                InitializeAcl, InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, PSID,
                SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SetSecurityDescriptorDacl, TOKEN_QUERY,
                TOKEN_USER, TokenUser,
            },
            System::Threading::{
                CreateEventW, EVENT_ALL_ACCESS, EVENT_MODIFY_STATE, GetCurrentProcess, INFINITE,
                OpenEventW, OpenProcessToken, SetEvent, WaitForMultipleObjects,
            },
        },
        core::PCWSTR,
    };

    fn failed(error: impl std::fmt::Display) -> AppError {
        AppError::new("ACTIVATION_FAILED", error.to_string())
    }
    fn handle(value: &OwnedHandle) -> HANDLE {
        HANDLE(value.as_raw_handle())
    }
    // Every successful Win32 creation/open transfers one owned handle into Rust.
    unsafe fn owned(value: HANDLE) -> OwnedHandle {
        unsafe { OwnedHandle::from_raw_handle(value.0) }
    }

    struct UserSid {
        // Windows limits SIDs to 68 bytes. DWORD alignment also satisfies ACL APIs.
        bytes: [u32; 17],
        length: usize,
    }
    impl UserSid {
        fn current() -> AppResult<Self> {
            let mut token = HANDLE::default();
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
                .map_err(failed)?;
            let token = unsafe { owned(token) };
            let mut information = [0usize; 64];
            let mut length = 0;
            unsafe {
                GetTokenInformation(
                    handle(&token),
                    TokenUser,
                    Some(information.as_mut_ptr().cast()),
                    std::mem::size_of_val(&information) as u32,
                    &mut length,
                )
            }
            .map_err(failed)?;
            let user = unsafe { &*information.as_ptr().cast::<TOKEN_USER>() };
            let length = unsafe { GetLengthSid(user.User.Sid) } as usize;
            let mut sid = Self {
                bytes: [0; 17],
                length,
            };
            if length == 0 || length > std::mem::size_of_val(&sid.bytes) {
                return Err(failed("The current user's SID is invalid"));
            }
            unsafe {
                std::ptr::copy_nonoverlapping(
                    user.User.Sid.0.cast::<u8>(),
                    sid.bytes.as_mut_ptr().cast::<u8>(),
                    length,
                )
            };
            Ok(sid)
        }
        fn bytes(&self) -> &[u8] {
            unsafe { std::slice::from_raw_parts(self.bytes.as_ptr().cast(), self.length) }
        }
        fn pointer(&self) -> PSID {
            PSID(self.bytes.as_ptr().cast_mut().cast())
        }
    }

    fn event_name(profile: &Path, user: &[u8]) -> AppResult<Vec<u16>> {
        // GetFinalPathNameByHandle-based canonicalization collapses relative paths,
        // dot components and Windows path aliases before deriving the endpoint.
        let canonical = std::fs::canonicalize(profile)?;
        let mut digest = Sha256::new();
        digest.update(b"TexyPaper restore v1\0");
        digest.update(user);
        digest.update([0]);
        for unit in canonical.as_os_str().encode_wide() {
            digest.update(unit.to_le_bytes());
        }
        Ok(format!("Local\\TexyPaper.restore.{:x}", digest.finalize())
            .encode_utf16()
            .chain(Some(0))
            .collect())
    }

    /// Created immediately after acquiring the profile lock, before controller setup.
    /// Auto-reset retains a launch arriving before the main window/tray is ready.
    pub struct Listener {
        restore: OwnedHandle,
        stop: OwnedHandle,
    }
    impl Listener {
        pub fn new(profile: &Path) -> AppResult<Self> {
            let user = UserSid::current()?;
            let name = event_name(profile, user.bytes())?;
            // Do not rely on a token's possibly permissive default DACL. Only this
            // user's SID gets access; other users cannot signal even a known name.
            let mut acl_storage = [0u32; 32];
            let acl = acl_storage.as_mut_ptr().cast::<ACL>();
            let mut descriptor = SECURITY_DESCRIPTOR::default();
            let descriptor_ptr =
                PSECURITY_DESCRIPTOR((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast());
            unsafe {
                InitializeAcl(
                    acl,
                    std::mem::size_of_val(&acl_storage) as u32,
                    ACL_REVISION,
                )
                .map_err(failed)?;
                AddAccessAllowedAce(acl, ACL_REVISION, EVENT_ALL_ACCESS.0, user.pointer())
                    .map_err(failed)?;
                InitializeSecurityDescriptor(descriptor_ptr, 1).map_err(failed)?;
                SetSecurityDescriptorDacl(descriptor_ptr, true, Some(acl), false)
                    .map_err(failed)?;
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor_ptr.0,
                bInheritHandle: false.into(),
            };
            let restore =
                unsafe { CreateEventW(Some(&attributes), false, false, PCWSTR(name.as_ptr())) }
                    .map_err(failed)?;
            let restore = unsafe { owned(restore) };
            let stop =
                unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(failed)?;
            Ok(Self {
                restore,
                stop: unsafe { owned(stop) },
            })
        }

        pub fn start(self, restore: impl Fn() + Send + 'static) -> AppResult<Server> {
            let stop = Arc::new(self.stop);
            let worker_stop = stop.clone();
            let event = self.restore;
            let worker = thread::Builder::new()
                .name("profile-activation".into())
                .spawn(move || {
                    let handles = [handle(&worker_stop), handle(&event)];
                    loop {
                        let result = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
                        if result == WAIT_OBJECT_0 {
                            break;
                        }
                        if result.0 != WAIT_OBJECT_0.0 + 1 {
                            eprintln!(
                                "TexyPaper activation listener stopped: {}",
                                std::io::Error::last_os_error()
                            );
                            break;
                        }
                        restore();
                    }
                })
                .map_err(failed)?;
            Ok(Server {
                stop,
                worker: Mutex::new(Some(worker)),
            })
        }
    }

    pub struct Server {
        stop: Arc<OwnedHandle>,
        worker: Mutex<Option<JoinHandle<()>>>,
    }
    impl Server {
        pub fn shutdown(&self) {
            // Stop has priority over a concurrent restore. Joining closes the named
            // event before normal exit releases the profile's exclusive lock.
            let _ = unsafe { SetEvent(handle(&self.stop)) };
            if let Ok(mut worker) = self.worker.lock()
                && let Some(worker) = worker.take()
            {
                let _ = worker.join();
            }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.shutdown();
        }
    }

    pub fn request_existing(profile: &Path) -> AppResult<bool> {
        let user = UserSid::current()?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // A concurrently starting owner may still be migrating/creating its
            // directory. Legacy clients never expose this endpoint; refuse normally.
            match event_name(profile, user.bytes()) {
                Ok(name) => {
                    match unsafe { OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(name.as_ptr())) } {
                        Ok(event) => {
                            let event = unsafe { owned(event) };
                            unsafe { SetEvent(handle(&event)) }.map_err(failed)?;
                            return Ok(true);
                        }
                        Err(error) if error.code().0 == 0x80070002u32 as i32 => {}
                        Err(error) => return Err(failed(error)),
                    }
                }
                Err(error) if !profile.exists() => {
                    let _ = error;
                }
                Err(error) => return Err(error),
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::mpsc;

        #[test]
        fn canonical_alias_activates_only_its_profile_and_shutdown_removes_endpoint() {
            let temp = tempfile::tempdir().unwrap();
            let first = temp.path().join("first");
            let second = temp.path().join("second");
            std::fs::create_dir(&first).unwrap();
            std::fs::create_dir(&second).unwrap();
            let _first_lock = crate::migration::prepare_profile(&first, true).unwrap();
            let _second_lock = crate::migration::prepare_profile(&second, true).unwrap();
            let (first_send, first_recv) = mpsc::channel();
            let (second_send, second_recv) = mpsc::channel();
            let first_listener = Listener::new(&first).unwrap();
            let second_server = Listener::new(&second)
                .unwrap()
                .start(move || {
                    let _ = second_send.send(());
                })
                .unwrap();
            // A second launch before native window setup must remain queued.
            assert!(request_existing(&first.join("..").join("first")).unwrap());
            let first_server = first_listener
                .start(move || {
                    let _ = first_send.send(());
                })
                .unwrap();
            first_recv.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(second_recv.try_recv().is_err());
            assert!(request_existing(&second).unwrap());
            second_recv.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(first_recv.try_recv().is_err());
            first_server.shutdown();
            assert!(!request_existing(&first).unwrap());
            assert!(request_existing(&second).unwrap());
            second_recv.recv_timeout(Duration::from_secs(2)).unwrap();
            second_server.shutdown();
        }

        #[test]
        fn endpoint_identity_separates_users_even_for_the_same_canonical_profile() {
            let temp = tempfile::tempdir().unwrap();
            assert_ne!(
                event_name(temp.path(), b"user-one").unwrap(),
                event_name(temp.path(), b"user-two").unwrap()
            );
        }
    }
}

#[cfg(windows)]
pub use platform::{Listener, Server, request_existing};

// Current releases target Windows. Other platforms retain exclusive-lock refusal
// rather than exposing an unauthenticated fallback transport.
#[cfg(not(windows))]
pub struct Listener;
#[cfg(not(windows))]
pub struct Server;
#[cfg(not(windows))]
impl Listener {
    pub fn new(_: &Path) -> AppResult<Self> {
        Ok(Self)
    }
    pub fn start(self, _: impl Fn() + Send + 'static) -> AppResult<Server> {
        Ok(Server)
    }
}
#[cfg(not(windows))]
impl Server {
    pub fn shutdown(&self) {}
}
#[cfg(not(windows))]
pub fn request_existing(_: &Path) -> AppResult<bool> {
    Ok(false)
}
