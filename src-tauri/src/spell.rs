//! Read-only English checking. Windows COM objects live exclusively on one lazy,
//! process-lifetime MTA worker, never on shared blocking-pool/calling threads.
//! The SCOWL fallback remains lazy; no engine writes to user dictionaries.
use crate::contracts::{AppError, AppResult};
use serde_json::{Value, json};

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_WORD_CHARS: usize = 64;
fn input<'a>(args: &'a Value, key: &str, limit: usize, bytes: bool) -> AppResult<&'a str> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_SPELL_INPUT", format!("{key} must be a string")))?;
    let length = if bytes {
        value.len()
    } else {
        value.chars().count()
    };
    if value.contains('\0') || length > limit {
        return Err(AppError::new(
            "INVALID_SPELL_INPUT",
            format!("{key} exceeds its limit or contains NUL"),
        ));
    }
    Ok(value)
}
fn language(args: &Value) -> AppResult<Option<&'static str>> {
    match args.get("language") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value == "en-US" => Ok(Some("en-US")),
        Some(Value::String(value)) if value == "en-GB" => Ok(Some("en-GB")),
        _ => Err(AppError::new(
            "INVALID_SPELL_INPUT",
            "Only en-US and en-GB are supported",
        )),
    }
}
// Windows indices are already UTF-16. Validate against code-unit length, never UTF-8 bytes.
fn valid_span(utf16_length: usize, start: u32, length: u32) -> bool {
    length > 0
        && (start as usize)
            .checked_add(length as usize)
            .is_some_and(|end| end <= utf16_length)
}
pub fn validate_settings(settings: &Value) -> AppResult<()> {
    if settings
        .get("spellCheck")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(AppError::new(
            "INVALID_SETTINGS",
            "spellCheck must be a boolean",
        ));
    }
    if let Some(value) = settings.get("spellIgnore") {
        let valid = value.as_array().is_some_and(|words| {
            let mut seen = std::collections::HashSet::new();
            words.len() <= 500
                && words.iter().all(|word| {
                    word.as_str().is_some_and(|word| {
                        !word.is_empty()
                            && word.chars().count() <= MAX_WORD_CHARS
                            && !word.contains('\0')
                            && seen.insert(word.to_lowercase())
                    })
                })
        });
        if !valid {
            return Err(AppError::new(
                "INVALID_SETTINGS",
                "spellIgnore must contain at most 500 unique words of 1–64 characters",
            ));
        }
    }
    Ok(())
}
pub fn execute(command: &str, args: &Value) -> AppResult<Value> {
    execute_using(command, args, false)
}
// Internal test hook exercises the real fallback even on Windows with English installed.
fn execute_using(command: &str, args: &Value, bundled_only: bool) -> AppResult<Value> {
    let requested = language(args)?;
    let text = match command {
        "spell_status" => "",
        "spell_check" => input(args, "text", MAX_TEXT_BYTES, true)?,
        "spell_suggest" => input(args, "word", MAX_WORD_CHARS, false)?,
        _ => return Err(AppError::new("UNKNOWN_COMMAND", "Unknown spell command")),
    };
    if bundled_only {
        return execute_bundled(command, text);
    }
    #[cfg(windows)]
    {
        platform::execute(command, text, requested)
    }
    #[cfg(not(windows))]
    {
        let _ = requested;
        execute_bundled(command, text)
    }
}
fn execute_bundled(command: &str, text: &str) -> AppResult<Value> {
    match command {
        "spell_status" => Ok(bundled::status()),
        "spell_check" => bundled::check(text),
        "spell_suggest" => bundled::suggest(text),
        _ => unreachable!("command validated before engine dispatch"),
    }
}

mod bundled {
    use super::*;
    use std::sync::OnceLock;
    use unicode_segmentation::UnicodeSegmentation;

    static DICTIONARY: OnceLock<Result<spellbook::Dictionary, String>> = OnceLock::new();
    fn dictionary() -> AppResult<&'static spellbook::Dictionary> {
        DICTIONARY
            .get_or_init(|| {
                spellbook::Dictionary::new(
                    include_str!("../resources/spelling/en_US.aff"),
                    include_str!("../resources/spelling/en_US.dic"),
                )
                .map_err(|error| error.to_string())
            })
            .as_ref()
            .map_err(|error| AppError::new("SPELL_DICTIONARY_FAILED", error))
    }
    // Status must not touch DICTIONARY: the UI probes it even when checking is off.
    pub fn status() -> Value {
        json!({"available":true,"languages":["en-US"],"engine":"bundled"})
    }
    fn eligible(word: &str) -> bool {
        let length = word.chars().count();
        (2..=MAX_WORD_CHARS).contains(&length)
            && word
                .chars()
                .all(|character| character.is_ascii_alphabetic() || matches!(character, '\'' | '’'))
            && !word.bytes().all(|byte| byte.is_ascii_uppercase())
    }
    pub fn check(text: &str) -> AppResult<Value> {
        let dictionary = dictionary()?;
        let mut errors = Vec::new();
        let (mut byte_cursor, mut utf16_cursor) = (0, 0);
        // Unicode word boundaries retain internal apostrophes, split hyphens, and
        // keep digits inside identifiers so an English fragment is never checked.
        for (byte_start, word) in text.unicode_word_indices() {
            utf16_cursor += text[byte_cursor..byte_start].encode_utf16().count();
            let start = utf16_cursor;
            let length = word.encode_utf16().count();
            utf16_cursor += length;
            byte_cursor = byte_start + word.len();
            if eligible(word) && !dictionary.check(word) {
                errors.push(json!({"start":start,"length":length}));
                if errors.len() == 4096 {
                    break;
                }
            }
        }
        Ok(json!({"available":true,"errors":errors}))
    }
    pub fn suggest(word: &str) -> AppResult<Value> {
        let mut suggestions = Vec::new();
        if eligible(word) {
            dictionary()?.suggest(word, &mut suggestions);
        }
        suggestions.truncate(8);
        Ok(json!({"available":true,"suggestions":suggestions}))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        collections::BTreeMap,
        sync::{
            LazyLock,
            mpsc::{self, SyncSender},
        },
        thread::JoinHandle,
        time::Duration,
    };
    use windows::{
        Win32::{
            Globalization::{ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory},
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize,
            },
        },
        core::{HSTRING, PCWSTR, PWSTR},
    };

    const QUEUE_CAPACITY: usize = 8;
    const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
    enum Operation {
        Status,
        Check(String, Option<&'static str>),
        Suggest(String, Option<&'static str>),
    }
    struct Job {
        operation: Operation,
        reply: SyncSender<AppResult<Value>>,
    }
    struct Worker {
        sender: SyncSender<Job>,
        // The module owns exactly one worker for the process lifetime. If its
        // sender is dropped, recv ends and Session releases COM on that thread.
        _thread: JoinHandle<()>,
    }
    impl Worker {
        fn start() -> Result<Self, String> {
            let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
            let thread = std::thread::Builder::new()
                .name("texypaper-spell".into())
                .spawn(move || {
                    let session = Session::new();
                    while let Ok(job) = receiver.recv() {
                        // A single reply fits even if the caller has not started
                        // waiting; a timed-out/dropped caller cannot block this worker.
                        let _ = job.reply.send(session.execute(job.operation));
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(Self {
                sender,
                _thread: thread,
            })
        }
        fn request(&self, operation: Operation) -> AppResult<Value> {
            let (reply, receive) = mpsc::sync_channel(1);
            self.sender
                .try_send(Job { operation, reply })
                .map_err(|error| match error {
                    mpsc::TrySendError::Full(_) => {
                        AppError::new("SPELL_WORKER_BUSY", "Spell checker queue is full")
                    }
                    mpsc::TrySendError::Disconnected(_) => {
                        AppError::new("SPELL_WORKER_UNAVAILABLE", "Spell checker worker stopped")
                    }
                })?;
            receive
                .recv_timeout(REPLY_TIMEOUT)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => AppError::new(
                        "SPELL_WORKER_TIMEOUT",
                        "Spell checker did not reply within 15 seconds",
                    ),
                    mpsc::RecvTimeoutError::Disconnected => AppError::new(
                        "SPELL_WORKER_UNAVAILABLE",
                        "Spell checker worker stopped before replying",
                    ),
                })?
        }
    }
    static WORKER: LazyLock<Result<Worker, String>> = LazyLock::new(Worker::start);
    pub fn execute(command: &str, text: &str, language: Option<&'static str>) -> AppResult<Value> {
        // Validation in execute_using precedes worker startup and bounded text ownership.
        let operation = match command {
            "spell_status" => Operation::Status,
            "spell_check" => Operation::Check(text.to_owned(), language),
            "spell_suggest" => Operation::Suggest(text.to_owned(), language),
            _ => unreachable!("validated spell operation"),
        };
        WORKER
            .as_ref()
            .map_err(|error| AppError::new("SPELL_WORKER_UNAVAILABLE", error))?
            .request(operation)
    }
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    struct Session {
        // Drop order releases interfaces before balancing CoInitializeEx.
        checkers: BTreeMap<&'static str, ISpellChecker>,
        _factory: Option<ISpellCheckerFactory>,
        _apartment: Apartment,
    }
    impl Session {
        fn new() -> Self {
            let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let apartment = Apartment(initialized.is_ok());
            if initialized.is_err() {
                return Self {
                    checkers: BTreeMap::new(),
                    _factory: None,
                    _apartment: apartment,
                };
            }
            let factory: Option<ISpellCheckerFactory> =
                unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }.ok();
            let mut checkers = BTreeMap::new();
            if let Some(factory) = &factory {
                for tag in ["en-US", "en-GB"] {
                    let language = HSTRING::from(tag);
                    if unsafe { factory.IsSupported(&language) }
                        .is_ok_and(|supported| supported.as_bool())
                        && let Ok(checker) = unsafe { factory.CreateSpellChecker(&language) }
                    {
                        checkers.insert(tag, checker);
                    }
                }
            }
            Self {
                checkers,
                _factory: factory,
                _apartment: apartment,
            }
        }
        fn checker(&self, requested: Option<&str>) -> Option<&ISpellChecker> {
            requested
                .and_then(|language| self.checkers.get(language))
                .or_else(|| self.checkers.get("en-US"))
                .or_else(|| self.checkers.get("en-GB"))
        }
        fn execute(&self, operation: Operation) -> AppResult<Value> {
            match operation {
                Operation::Status if self.checkers.is_empty() => Ok(bundled::status()),
                Operation::Status => Ok(
                    json!({"available":true,"languages":self.checkers.keys().collect::<Vec<_>>(),"engine":"windows"}),
                ),
                Operation::Check(text, _) if self.checkers.is_empty() => bundled::check(&text),
                Operation::Check(text, language) => self.check(&text, language),
                Operation::Suggest(word, _) if self.checkers.is_empty() => bundled::suggest(&word),
                Operation::Suggest(word, language) => self.suggest(&word, language),
            }
        }
        fn check(&self, text: &str, language: Option<&str>) -> AppResult<Value> {
            let Some(checker) = self.checker(language) else {
                return Ok(json!({"available":false,"errors":[]}));
            };
            let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            let errors = unsafe { checker.Check(PCWSTR(wide.as_ptr())) }.map_err(com_error)?;
            let mut spans = Vec::new();
            loop {
                let mut error = None;
                let result = unsafe { errors.Next(&mut error) };
                result.ok().map_err(com_error)?;
                let Some(error) = error else {
                    break;
                };
                let start = unsafe { error.StartIndex() }.map_err(com_error)?;
                let length = unsafe { error.Length() }.map_err(com_error)?;
                if valid_span(wide.len() - 1, start, length) {
                    spans.push(json!({"start":start,"length":length}));
                }
                if spans.len() >= 4096 {
                    break;
                }
            }
            Ok(json!({"available":true,"errors":spans}))
        }
        fn suggest(&self, word: &str, language: Option<&str>) -> AppResult<Value> {
            let Some(checker) = self.checker(language) else {
                return Ok(json!({"available":false,"suggestions":[]}));
            };
            let word = HSTRING::from(word);
            let enumeration = unsafe { checker.Suggest(&word) }.map_err(com_error)?;
            let mut suggestions = Vec::new();
            for _ in 0..8 {
                let mut values = [PWSTR::null()];
                let mut fetched = 0;
                let result = unsafe { enumeration.Next(&mut values, Some(&mut fetched)) };
                let value = if !values[0].is_null() {
                    let value = unsafe { values[0].to_string() };
                    unsafe { CoTaskMemFree(Some(values[0].0.cast())) };
                    Some(value)
                } else {
                    None
                };
                result.ok().map_err(com_error)?;
                if fetched == 0 {
                    break;
                }
                if let Some(value) = value {
                    let value = value
                        .map_err(|error| AppError::new("SPELL_CHECK_FAILED", error.to_string()))?;
                    if !value.is_empty() && value.chars().count() <= MAX_WORD_CHARS {
                        suggestions.push(value);
                    }
                }
            }
            Ok(json!({"available":true,"suggestions":suggestions}))
        }
    }
    fn com_error(error: windows::core::Error) -> AppError {
        AppError::new("SPELL_CHECK_FAILED", error.to_string())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn queue_saturation_and_disconnection_return_explicit_errors() {
            let (sender, receive) = mpsc::sync_channel(QUEUE_CAPACITY);
            let worker = Worker {
                sender,
                _thread: std::thread::spawn(|| {}),
            };
            for _ in 0..QUEUE_CAPACITY {
                let (reply, _) = mpsc::sync_channel(1);
                assert!(
                    worker
                        .sender
                        .try_send(Job {
                            operation: Operation::Status,
                            reply
                        })
                        .is_ok()
                );
            }
            assert_eq!(
                worker.request(Operation::Status).unwrap_err().code,
                "SPELL_WORKER_BUSY"
            );
            drop(receive);
            assert_eq!(
                worker.request(Operation::Status).unwrap_err().code,
                "SPELL_WORKER_UNAVAILABLE"
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_reject_oversized_and_nul_inputs() {
        assert!(execute("spell_check", &json!({"text":"a".repeat(MAX_TEXT_BYTES+1)})).is_err());
        assert!(
            execute(
                "spell_check",
                &json!({"text":"한".repeat(MAX_TEXT_BYTES/3+1)})
            )
            .is_err()
        );
        assert!(execute("spell_suggest", &json!({"word":"a".repeat(65)})).is_err());
        assert!(execute("spell_check", &json!({"text":"hello\0ignored"})).is_err());
        assert!(execute("spell_check", &json!({"text":"hello","language":"ko-KR"})).is_err());
        assert!(input(&json!({"word":"한".repeat(64)}), "word", 64, false).is_ok());
        assert!(
            input(
                &json!({"text":"a".repeat(MAX_TEXT_BYTES)}),
                "text",
                MAX_TEXT_BYTES,
                true
            )
            .is_ok()
        );
    }
    #[test]
    fn offsets_are_utf16_not_utf8_or_scalar_indices() {
        let text = "한😀 wrong";
        let prefix = "한😀 ";
        let start = prefix.encode_utf16().count() as u32;
        assert_eq!(start, 4);
        assert!(valid_span(text.encode_utf16().count(), start, 5));
        assert!(!valid_span(text.encode_utf16().count(), start, 6));
        assert!(!valid_span(10, 0, 0));
        assert!(!valid_span(10, u32::MAX, u32::MAX));
    }
    #[test]
    fn ignored_settings_are_bounded_unique_and_explicit() {
        assert!(validate_settings(&json!({"spellCheck":true,"spellIgnore":["TeXyPaper"]})).is_ok());
        for invalid in [
            json!({"spellCheck":1}),
            json!({"spellIgnore":["word","WORD"]}),
            json!({"spellIgnore":[""]}),
            json!({"spellIgnore":["a".repeat(65)]}),
            json!({"spellIgnore":vec!["word";501]}),
        ] {
            assert!(validate_settings(&invalid).is_err());
        }
    }
    const CORRECTIONS: [(&str, &str); 5] = [
        ("sentense", "sentence"),
        ("mispeled", "misspelled"),
        ("wrod", "word"),
        ("anoter", "another"),
        ("contians", "contains"),
    ];
    #[test]
    fn bundled_engine_flags_each_typo_after_non_bmp_characters() {
        for (typo, _) in CORRECTIONS {
            let result =
                execute_using("spell_check", &json!({"text":format!("😀 {typo}")}), true).unwrap();
            assert_eq!(
                result["errors"],
                json!([{"start":3,"length":typo.len()}]),
                "{typo}"
            );
        }
        let text = "😀 This sentense is mispeled; a wrod and anoter contians.";
        let expected: Vec<Value> = CORRECTIONS
            .iter()
            .map(|(typo, _)| {
                let byte = text.find(typo).unwrap();
                json!({"start":text[..byte].encode_utf16().count(),"length":typo.len()})
            })
            .collect();
        assert_eq!(
            execute_using("spell_check", &json!({"text":text}), true).unwrap()["errors"],
            json!(expected)
        );
    }
    #[test]
    fn bundled_engine_accepts_correct_words_and_internal_apostrophes() {
        let result = execute_using("spell_check", &json!({"text":"A correct sentence in a paper. don't paper's well-known don’t paper’s 'sentence' ‘paper’"}), true).unwrap();
        assert_eq!(result["errors"], json!([]));
        let result = execute_using("spell_check", &json!({"text":"well-mispeled"}), true).unwrap();
        assert_eq!(result["errors"], json!([{"start":5,"length":8}]));
    }
    #[test]
    fn bundled_engine_ignores_nonwords_identifiers_acronyms_and_single_letters() {
        let text = "NASA QZX I x qzx42 wrng123 123wrng under_score 한글 café 中文";
        assert_eq!(
            execute_using("spell_check", &json!({"text":text}), true).unwrap()["errors"],
            json!([])
        );
    }
    #[test]
    fn bundled_engine_suggests_required_corrections_with_bounded_output() {
        for (typo, correction) in CORRECTIONS {
            let result = execute_using("spell_suggest", &json!({"word":typo}), true).unwrap();
            let suggestions = result["suggestions"].as_array().unwrap();
            assert!(suggestions.len() <= 8);
            assert!(
                suggestions.iter().any(|word| word == correction),
                "{typo}: {suggestions:?}"
            );
        }
    }
    #[test]
    fn bundled_status_and_forced_input_guards_work_without_windows_dictionaries() {
        assert_eq!(
            execute_using("spell_status", &json!({}), true).unwrap(),
            json!({"available":true,"languages":["en-US"],"engine":"bundled"})
        );
        for (command, args) in [
            ("spell_check", json!({"text":"a".repeat(MAX_TEXT_BYTES+1)})),
            ("spell_check", json!({"text":"hello\0ignored"})),
            (
                "spell_suggest",
                json!({"word":"a".repeat(MAX_WORD_CHARS+1)}),
            ),
            ("spell_suggest", json!({"word":"wrong\0"})),
        ] {
            assert_eq!(
                execute_using(command, &args, true).unwrap_err().code,
                "INVALID_SPELL_INPUT"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn public_spell_ops_leave_calling_threads_free_for_sta_dialogs() {
        use windows::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
        };
        let results: Vec<_> = [
            ("spell_status", json!({})),
            ("spell_check", json!({"text":"A correct sentence."})),
            ("spell_suggest", json!({"word":"sentense"})),
        ]
        .into_iter()
        .map(|(command, args)| {
            std::thread::spawn(move || {
                execute(command, &args).unwrap();
                let sta = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
                if sta.is_ok() {
                    unsafe { CoUninitialize() };
                }
                (command, sta)
            })
            .join()
            .unwrap()
        })
        .collect();
        assert!(
            results.iter().all(|(_, sta)| sta.is_ok()),
            "Spell entry points changed their callers' COM apartment: {results:?}"
        );
    }
    #[test]
    fn selected_engine_returns_utf16_spans() {
        let status = execute("spell_status", &json!({})).unwrap();
        assert_eq!(status["available"], true);
        assert!(matches!(
            status["engine"].as_str(),
            Some("windows" | "bundled")
        ));
        let result = execute("spell_check", &json!({"text":"😀 qzxwvvv"})).unwrap();
        assert!(
            result["errors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|error| error["start"] == 3 && error["length"] == 7)
        );
        assert!(
            execute("spell_suggest", &json!({"word":"wrng"})).unwrap()["suggestions"]
                .as_array()
                .unwrap()
                .len()
                <= 8
        );
    }
}
