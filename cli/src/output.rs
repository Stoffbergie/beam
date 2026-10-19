use std::borrow::Cow;
use std::fmt::Display;
use std::io::IsTerminal;
use std::sync::LazyLock;
use std::time::Duration;

static COLOR: LazyLock<bool> = LazyLock::new(|| {
    std::io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none()
        && !std::env::var("TERM").is_ok_and(|term| term == "dumb")
});

pub fn dim(text: &str) -> Cow<'_, str> {
    if *COLOR {
        Cow::Owned(format!("\x1b[90m{text}\x1b[0m"))
    } else {
        Cow::Borrowed(text)
    }
}

pub fn note(message: &str) {
    eprintln!("{}", dim(message));
}

pub fn request(method: &str, path: &str, status: u16, detail: impl Display) {
    if *COLOR {
        println!("{method:<7} {status:<4} {path} \x1b[90m{detail}\x1b[0m");
    } else {
        println!("{method:<7} {status:<4} {path} {detail}");
    }
}

pub fn duration(elapsed: Duration) -> String {
    let millis = elapsed.as_millis();
    if millis < 1000 {
        format!("{millis}ms")
    } else {
        format!("{:.1}s", elapsed.as_secs_f64())
    }
}
