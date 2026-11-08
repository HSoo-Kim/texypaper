//! Each native dialog owns a fresh STA thread, never a shared Tokio worker.
//! rfd 0.15's file-dialog API returns Option and discards its backend HRESULT
//! (`run(self).ok()` in win_cid/file_dialog.rs). We can diagnose COM/thread/panic
//! failures here, but remaining rfd errors cannot be distinguished from cancel.
use crate::contracts::{AppError, AppResult};

#[cfg(windows)]
struct Apartment;
#[cfg(windows)]
impl Apartment {
    fn initialize() -> AppResult<Self> {
        use windows::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx,
        };
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
            .ok()
            .map_err(|error| AppError::new("DIALOG_UNAVAILABLE", error.to_string()))?;
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

pub fn run<T: Send + 'static>(action: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    std::thread::Builder::new()
        .name("texypaper-dialog".into())
        .spawn(move || {
            #[cfg(windows)]
            let _apartment = Apartment::initialize()?;
            Ok(action())
        })
        .map_err(|error| AppError::new("DIALOG_UNAVAILABLE", error.to_string()))?
        .join()
        .map_err(|_| AppError::new("DIALOG_UNAVAILABLE", "Native dialog thread panicked"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_dialog_request_gets_a_new_thread_and_returns_its_value() {
        let caller = std::thread::current().id();
        let first = run(|| (std::thread::current().id(), 42)).unwrap();
        let second = run(|| std::thread::current().id()).unwrap();
        assert_eq!(first.1, 42);
        assert_ne!(first.0, caller);
        assert_ne!(second, caller);
        assert_ne!(first.0, second);
    }
    #[test]
    fn dialog_thread_panics_are_explicit_errors_not_cancellation() {
        let error = run(|| panic!("synthetic dialog failure")).unwrap_err();
        assert_eq!(error.code, "DIALOG_UNAVAILABLE");
    }
    #[cfg(windows)]
    #[test]
    fn an_mta_caller_can_run_a_dialog_in_a_separate_sta() {
        use windows::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize,
        };
        std::thread::spawn(|| {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .unwrap();
            let caller = std::thread::current().id();
            let result = run(|| {
                let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
                if initialized.is_ok() {
                    unsafe { CoUninitialize() };
                }
                (std::thread::current().id(), initialized)
            });
            unsafe { CoUninitialize() };
            let (dialog, initialized) = result.unwrap();
            assert_ne!(caller, dialog);
            assert!(
                initialized.is_ok(),
                "Fresh dialog thread was not STA: {initialized:?}"
            );
        })
        .join()
        .unwrap();
    }
}
