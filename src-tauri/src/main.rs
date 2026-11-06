#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let mode = if std::env::var_os("TEXYPAPER_ASKPASS_ADDRESS").is_some()
        && std::env::var_os("TEXYPAPER_ASKPASS_TOKEN").is_some()
    {
        Some("--ssh-askpass".to_owned())
    } else {
        std::env::args().nth(1)
    };
    let result = match mode.as_deref() {
        Some("--mcp-stdio") => texypaper_lib::ai::mcp_stdio_main(),
        Some("--ssh-askpass") => texypaper_lib::ssh_askpass::ssh_askpass_main(),
        _ => {
            texypaper_lib::run();
            return;
        }
    };
    if let Err(error) = result {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
}
