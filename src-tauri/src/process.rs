use crate::contracts::{AppError, AppResult};
use std::process::{Child, Command, ExitStatus};

/// Owns the complete subprocess tree, not merely the launcher PID.
pub struct OwnedChild {
    child: Child,
    #[cfg(windows)]
    job: windows_job::Job,
    reaped: bool,
}
impl OwnedChild {
    pub fn spawn(command: &mut Command) -> AppResult<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Assignment must precede the child's first instruction: otherwise a
            // fast launcher can create descendants outside our kill-on-close job.
            command.creation_flags(0x00000004 | 0x08000000);
            let job = windows_job::Job::new()?;
            let mut child = command.spawn()?;
            if let Err(error) = job.assign_and_resume(&child) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            crate::resources::register_process(child.id(), command.get_program());
            Ok(Self {
                child,
                job,
                reaped: false,
            })
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            let child = command.spawn()?;
            crate::resources::register_process(child.id(), command.get_program());
            Ok(Self {
                child,
                reaped: false,
            })
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = command;
            Err(AppError::new(
                "PROCESS_UNSUPPORTED",
                "Process-tree ownership is unavailable on this platform",
            ))
        }
    }
    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }
    pub fn id(&self) -> u32 {
        self.child.id()
    }
    pub fn try_wait(&mut self) -> AppResult<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }
    pub fn wait(&mut self) -> AppResult<ExitStatus> {
        let status = self.child.wait()?;
        self.reaped = true;
        Ok(status)
    }
    pub fn cancel(&mut self) -> AppResult<()> {
        #[cfg(windows)]
        self.job.terminate()?;
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            // ESRCH means the owned group has already exited.
            if unsafe { kill(-(self.id() as i32), 9) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(3) {
                    return Err(error.into());
                }
            }
        }
        if !self.reaped {
            self.child.wait()?;
            self.reaped = true;
        }
        Ok(())
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // A reaped launcher can still have running descendants.
        let _ = self.cancel();
        crate::resources::unregister_process(self.child.id());
    }
}

#[cfg(windows)]
mod windows_job {
    use super::*;
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }
    pub(super) struct Job(Handle);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Job {
        pub fn new() -> AppResult<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let job = Self(handle);
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if unsafe {
                SetInformationJobObject(
                    handle,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(job)
        }
        pub fn assign_and_resume(&self, child: &Child) -> AppResult<()> {
            let process = child.as_raw_handle();
            if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let status = unsafe { NtResumeProcess(process) };
            if status < 0 {
                return Err(AppError::new(
                    "PROCESS_RESUME_FAILED",
                    format!("NtResumeProcess failed: {status:#x}"),
                ));
            }
            Ok(())
        }
        pub fn terminate(&self) -> AppResult<()> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        }
    }
    #[cfg(all(test, target_pointer_width = "64"))]
    mod tests {
        use super::*;
        #[test]
        fn job_information_layout_matches_windows_x64_abi() {
            assert_eq!(std::mem::size_of::<BasicLimits>(), 64);
            assert_eq!(std::mem::size_of::<IoCounters>(), 48);
            assert_eq!(std::mem::size_of::<ExtendedLimits>(), 144);
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
