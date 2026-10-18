use anyhow::{bail, Result};
use clap::{Parser, Subcommand};

mod api;
mod config;
mod forward;
mod output;

#[derive(Parser)]
#[command(
    name = "beam",
    version,
    about = "Your localhost, on the internet",
    args_conflicts_with_subcommands = true,
    subcommand_negates_reqs = true,
    after_help = "Examples:\n  beam 3000                      Give localhost:3000 a public URL\n  beam 3000 --name app           Use a fixed URL like app.beam.stoff.dev\n  beam 3000 -- npm run dev       Start the app, wait for the port, then share it\n  beam config --token <token>    Save the owner token\n\nSet BEAM_URL to use another server and BEAM_TOKEN to pass the token directly.\nCatching webhooks? Use hook: https://hook.stoff.dev"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(required = true, help = "Local port or URL to share")]
    target: Option<String>,

    #[arg(short, long, help = "Fixed name for the URL instead of a random one")]
    name: Option<String>,

    #[arg(last = true, help = "Command to start before sharing, after --")]
    run: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Show or set the owner token")]
    Config {
        #[arg(long, help = "Owner token that allows sharing; empty to remove")]
        token: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("beam: {error:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    match (cli.command, cli.target) {
        (Some(Command::Config { token }), _) => config::edit(token),
        (None, Some(target)) => share(target, cli.name, cli.run).await,
        (None, None) => unreachable!("clap requires a target"),
    }
}

async fn share(target: String, name: Option<String>, run: Vec<String>) -> Result<()> {
    let Some(token) = config::token()? else {
        bail!("sharing needs the owner token; set it with beam config --token <token>. Catching webhooks? Use hook: https://hook.stoff.dev");
    };
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

    let result = until_interrupted(forward::run(&name, &token, &target)).await;
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
