use anyhow::Result;
use clap::Parser;

mod api;
mod forward;
mod output;

#[derive(Parser)]
#[command(
    name = "beam",
    version,
    about = "Share local servers through public HTTPS URLs.",
    after_help = "Examples:\n  beam 3000                      Give localhost:3000 a public URL\n  beam 3000 --name app           Use a fixed URL like app.beam.stoff.dev\n  beam 3000 -- npm run dev       Start the app, wait for the port, then share it\n\nSet BEAM_URL to use another server.\nCatching webhooks? Use hook: https://hook.stoff.dev"
)]
struct Cli {
    #[arg(required = true, help = "Local port or URL to share")]
    target: String,

    #[arg(short, long, help = "Fixed name for the URL instead of a random one")]
    name: Option<String>,

    #[arg(last = true, help = "Command to start before sharing, after --")]
    run: Vec<String>,
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("beam: {error:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    if std::env::var_os("TOKIO_WORKER_THREADS").is_none() {
        let available = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1);
        runtime.worker_threads(available.min(2));
    }
    runtime
        .enable_all()
        .build()?
        .block_on(share(cli.target, cli.name, cli.run))
}

async fn share(target: String, name: Option<String>, run: Vec<String>) -> Result<()> {
    let token = api::connection_token()?;
    let target = forward::Target::parse(&target)?;
    let name = match name {
        Some(name) => name,
        None => api::random_name()?,
    };
    let mut child = None;
    if !run.is_empty() {
        output::note(&format!("Starting {}", run.join(" ")));
        let mut process = command(&run).spawn()?;
        if let Err(error) = forward::wait_for_port(&target, &mut process).await {
            stop(&mut process).await;
            return Err(error);
        }
        child = Some(process);
    }

    let result = until_interrupted(forward::run(&name, &token, target)).await;
    if let Some(mut child) = child {
        stop(&mut child).await;
    }
    result
}

async fn until_interrupted(task: impl std::future::Future<Output = Result<()>>) -> Result<()> {
    tokio::select! {
        result = task => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}

fn command(run: &[String]) -> tokio::process::Command {
    let mut process = match run {
        [line] if cfg!(windows) => {
            let mut process = tokio::process::Command::new("cmd");
            process.arg("/C").arg(line);
            process
        }
        [line] => {
            let mut process = tokio::process::Command::new("sh");
            process.arg("-c").arg(line);
            process
        }
        [program, args @ ..] => {
            let mut process = tokio::process::Command::new(program);
            process.args(args);
            process
        }
        [] => unreachable!("command is only built when one was given"),
    };
    process
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    process
}

async fn stop(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        let group = -(id as i32);
        unsafe { libc::kill(group, libc::SIGTERM) };
        let exited = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await;
        if exited.is_err() {
            unsafe { libc::kill(group, libc::SIGKILL) };
        }
    }
    let _ = child.kill().await;
}
