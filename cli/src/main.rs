use anyhow::{bail, Result};
use clap::{Parser, Subcommand};

mod api;
mod config;
mod forward;
mod output;
mod replay;
mod watch;

#[derive(Parser)]
#[command(
    name = "beam",
    version,
    about = "Your localhost, on the internet",
    args_conflicts_with_subcommands = true,
    after_help = "Examples:\n  beam                           Catch requests and print them as they arrive\n  beam 3000                      Give localhost:3000 a public URL\n  beam 3000 --name app           Use a fixed URL like app.stoffberg.dev\n  beam 3000 -- npm run dev       Start the app, wait for the port, then share it\n  beam replay app --to 3000      Send the latest captured request again\n  beam watch app                 Print requests to an existing beam\n  beam config --token <token>    Save the owner token needed for forwarding\n\nSet BEAM_URL to use another server and BEAM_TOKEN to pass the token directly."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(help = "Local port or URL to share; leave out to only catch requests")]
    target: Option<String>,

    #[arg(short, long, help = "Fixed name for the URL; needs the owner token")]
    name: Option<String>,

    #[arg(last = true, help = "Command to start before sharing, after --")]
    run: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Print requests to an existing beam as they arrive")]
    Watch {
        #[arg(help = "Beam name, URL, or watch link ending in #key")]
        beam: String,
    },
    #[command(about = "Send captured requests to a local server again")]
    Replay {
        #[arg(help = "Beam name, URL, or watch link ending in #key")]
        beam: String,
        #[arg(help = "Request ids to replay; defaults to the latest request")]
        ids: Vec<u64>,
        #[arg(long, help = "Local port or URL to send them to")]
        to: String,
    },
    #[command(about = "List beams created from this machine")]
    Ls,
    #[command(about = "Delete a beam and everything it recorded")]
    Rm {
        #[arg(help = "Beam name, URL, or watch link ending in #key")]
        beam: String,
    },
    #[command(about = "Show or set the owner token")]
    Config {
        #[arg(
            long,
            help = "Owner token that allows forwarding and fixed names; empty to remove"
        )]
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
    match cli.command {
        Some(Command::Watch { beam }) => {
            let beam = api::resolve(&beam)?;
            output::note(&format!("Watching {}. Stop anytime: Ctrl+C", beam.name));
            until_interrupted(watch::run(&beam)).await
        }
        Some(Command::Replay { beam, ids, to }) => {
            replay::run(&api::resolve(&beam)?, ids, &forward::Target::parse(&to)?).await
        }
        Some(Command::Ls) => {
            for (name, saved) in config::load()?.beams {
                println!("{name:<10} {}", saved.url);
            }
            Ok(())
        }
        Some(Command::Rm { beam }) => {
            let beam = api::resolve(&beam)?;
            api::delete(&beam).await?;
            let mut config = config::load()?;
            config.beams.remove(&beam.name);
            config::save(&config)?;
            println!("deleted {}", beam.name);
            Ok(())
        }
        Some(Command::Config { token }) => config::edit(token),
        None => share(cli.target, cli.name, cli.run).await,
    }
}

async fn share(target: Option<String>, name: Option<String>, run: Vec<String>) -> Result<()> {
    let token = config::token()?;
    if name.is_some() && token.is_none() {
        bail!("choosing a name needs the owner token; set it with beam config --token <token>");
    }

    let Some(target) = target else {
        if !run.is_empty() {
            bail!("give the port to share before --, like beam 3000 -- npm run dev");
        }
        let created = api::create(name.as_deref(), token.as_deref()).await?;
        println!("{}", created.url);
        output::note(&format!(
            "Requests appear below. Watch in a browser: {}",
            created.watch
        ));
        output::note("Stop anytime: Ctrl+C. The URL keeps catching for 7 days.");
        let beam = api::Beam {
            name: created.name,
            credential: created.key,
        };
        return until_interrupted(watch::run(&beam)).await;
    };

    let Some(token) = token else {
        bail!("forwarding needs the owner token; set it with beam config --token <token>, or run beam without a port to only catch requests");
    };
    let target = forward::Target::parse(&target)?;
    let mut child = None;
    if !run.is_empty() {
        let command = run.join(" ");
        output::note(&format!("Starting {command}"));
        let mut process = shell(&command).spawn()?;
        if let Err(error) = forward::wait_for_port(&target, &mut process).await {
            stop(&mut process).await;
            return Err(error);
        }
        child = Some(process);
    }

    let created = api::create(name.as_deref(), Some(&token)).await?;
    println!("{} → {}", created.url, target.display);
    output::note(&format!("Watch in a browser: {}", created.watch));
    output::note("Stop anytime: Ctrl+C");

    let result = until_interrupted(forward::run(&created.name, &token, &target)).await;
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

fn shell(command: &str) -> tokio::process::Command {
    let mut process = if cfg!(windows) {
        let mut process = tokio::process::Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = tokio::process::Command::new("sh");
        process.arg("-c").arg(command);
        process
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
