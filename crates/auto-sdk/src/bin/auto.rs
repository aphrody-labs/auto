#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::ExitCode;

use aphrody_auto::{
    VERSION,
    auth::{
        password::{hash_password, verify_password},
        rbac::generate_api_key,
        server::SqlAuthStore,
        totp::{decode_base32, totp},
    },
    balancer::{LoadBalancer, lb_router},
    config::resolve_runtime,
    docs, facturx, files, knowledge,
    mcp::handle_mcp_request,
    model::Document,
    server_rt::{build_native_server_router, default_auth_config},
};

fn usage() {
    println!(
        "auto {VERSION} — Aphrody Auto single LTO/AOT binary & Rust Better Auth SDK

Usage:
  auto version                                     Print version info
  auto config                                      Print resolved auto.toml + env config JSON
  auto auth hash-password <password>               Hash password with Argon2id
  auto auth verify-password <password> <hash>      Verify Argon2id or Better Auth Scrypt hash
  auto auth keygen [prefix]                        Generate an auto_ API key + SHA-256 hash
  auto auth totp <base32_secret> [unix_secs]       Compute 6-digit RFC 6238 TOTP code
  auto pdf render <doc.json> <out.pdf>             Render Document JSON to PDF
  auto pdf count <file.pdf>                        Count PDF pages
  auto pdf text <file.pdf>                         Extract text from PDF
  auto facturx generate <doc.json> <out.pdf>       Render Factur-X PDF/A-3b
  auto facturx extract-xml <file.pdf>              Extract CII XML from Factur-X PDF
  auto facturx verify-pdfa <file.pdf>              Check PDF/A-3b invariants
  auto docx fields <file.docx>                     List DOCX template fields
  auto docx to-pdf <file.docx> <out.pdf>           Convert DOCX to PDF
  auto chunk <source> <file.txt> [size]            Chunk text for RAG knowledge
  auto mcp                                         Run JSON-RPC 2.0 MCP server on stdio
  auto serve [--port N] [--host H] [--db PATH]     Start native Rust Better Auth + Factur-X + MCP server
  auto lb [--listen H:P] [--upstreams U1,U2]       Start real-time L7 health-probed load balancer
  auto desktop                                     Launch auto-desktop GPUI binary"
    );
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("auto error: {msg}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: &[String]) -> Result<(), String> {
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    match cmd {
        "help" | "-h" | "--help" => {
            usage();
            Ok(())
        }
        "version" | "-V" | "--version" => {
            println!("auto {VERSION}");
            Ok(())
        }
        "config" => {
            let cfg = resolve_runtime(None).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?);
            Ok(())
        }
        "auth" => cmd_auth(&args[1..]),
        "pdf" => cmd_pdf(&args[1..]),
        "facturx" => cmd_facturx(&args[1..]),
        "docx" => cmd_docx(&args[1..]),
        "chunk" => {
            let source = args.get(1).ok_or("usage: auto chunk <source> <file> [size]")?;
            let path = args.get(2).ok_or("usage: auto chunk <source> <file> [size]")?;
            let size = args.get(3).and_then(|s| s.parse::<usize>().ok());
            let txt = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let chunks = knowledge::chunk_text(source, &txt, size).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&chunks).map_err(|e| e.to_string())?);
            Ok(())
        }
        "mcp" => {
            let stdin = std::io::stdin();
            let mut stdout = std::io::stdout();
            for line in stdin.lock().lines() {
                let line = line.map_err(|e| e.to_string())?;
                if line.trim().is_empty() {
                    continue;
                }
                let req: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if let Some(reply) = handle_mcp_request(&req) {
                    writeln!(stdout, "{}", serde_json::to_string(&reply).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    stdout.flush().map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        "serve" => {
            let mut cfg = resolve_runtime(None).map_err(|e| e.to_string())?;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--port" if i + 1 < args.len() => {
                        cfg.port = args[i + 1].parse().map_err(|_| "invalid port")?;
                        i += 2;
                    }
                    "--host" if i + 1 < args.len() => {
                        cfg.host = args[i + 1].clone();
                        i += 2;
                    }
                    "--db" if i + 1 < args.len() => {
                        cfg.db_path = args[i + 1].clone();
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            if cfg.db_path != ":memory:"
                && let Some(parent) = Path::new(&cfg.db_path).parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let auth_cfg = default_auth_config(&cfg);
            let store = SqlAuthStore::open(&cfg.db_path, auth_cfg).map_err(|e| e.to_string())?;
            let router = build_native_server_router(&cfg, store);
            let bind = format!("{}:{}", cfg.host, cfg.port);
            let listener = tokio::net::TcpListener::bind(&bind).await.map_err(|e| e.to_string())?;
            eprintln!("auto native server listening on http://{bind} (mode={})", cfg.mode);
            axum::serve(listener, router).await.map_err(|e| e.to_string())
        }
        "lb" => {
            let mut cfg = resolve_runtime(None).map_err(|e| e.to_string())?;
            let mut listen = format!("{}:{}", cfg.host, cfg.port);
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--listen" if i + 1 < args.len() => {
                        listen = args[i + 1].clone();
                        i += 2;
                    }
                    "--upstreams" if i + 1 < args.len() => {
                        cfg.upstreams = args[i + 1]
                            .split(',')
                            .map(|s| s.trim().trim_end_matches('/').to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        i += 2;
                    }
                    "--strategy" if i + 1 < args.len() => {
                        cfg.load_balancer.strategy = args[i + 1].clone();
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            let lb = LoadBalancer::new(&cfg.upstreams, cfg.load_balancer).map_err(|e| e.to_string())?;
            lb.probe_once().await;
            let _probe_task = lb.spawn_health_loop();
            let listener = tokio::net::TcpListener::bind(&listen).await.map_err(|e| e.to_string())?;
            eprintln!("auto load balancer listening on http://{listen} -> {} upstreams", lb.upstreams.len());
            axum::serve(listener, lb_router(lb)).await.map_err(|e| e.to_string())
        }
        "desktop" => {
            let exe = std::env::current_exe()
                .ok()
                .and_then(|p| {
                    p.parent().map(|d| d.join(if cfg!(windows) { "auto-desktop.exe" } else { "auto-desktop" }))
                })
                .filter(|p| p.exists())
                .unwrap_or_else(|| {
                    std::path::PathBuf::from(if cfg!(windows) { "auto-desktop.exe" } else { "auto-desktop" })
                });
            let status = std::process::Command::new(&exe)
                .args(&args[1..])
                .status()
                .map_err(|e| format!("failed launching {}: {e}", exe.display()))?;
            if status.success() { Ok(()) } else { Err(format!("auto-desktop exited with {status}")) }
        }
        other => Err(format!("unknown subcommand: {other}")),
    }
}

fn cmd_auth(args: &[String]) -> Result<(), String> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    match sub {
        "hash-password" => {
            let pw = args.get(1).ok_or("usage: auto auth hash-password <password>")?;
            println!("{}", hash_password(pw).map_err(|e| e.to_string())?);
            Ok(())
        }
        "verify-password" => {
            let pw = args.get(1).ok_or("usage: auto auth verify-password <password> <hash>")?;
            let hash = args.get(2).ok_or("usage: auto auth verify-password <password> <hash>")?;
            let ok = verify_password(pw, hash).map_err(|e| e.to_string())?;
            println!("{{\"valid\":{ok}}}");
            Ok(())
        }
        "keygen" => {
            let prefix = args.get(1).map(String::as_str).unwrap_or("auto_");
            let generated = generate_api_key(prefix).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&generated).map_err(|e| e.to_string())?);
            Ok(())
        }
        "totp" => {
            let secret = args.get(1).ok_or("usage: auto auth totp <base32_secret> [unix_secs]")?;
            let secs = args.get(2).and_then(|s| s.parse::<u64>().ok()).unwrap_or_else(|| {
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
            });
            let raw = decode_base32(secret).map_err(|e| e.to_string())?;
            let code =
                totp(&raw, secs, 6, 30, aphrody_auto::auth::totp::TotpAlgorithm::Sha1).map_err(|e| e.to_string())?;
            println!("{code}");
            Ok(())
        }
        other => Err(format!("unknown auth subcommand: {other}")),
    }
}

fn cmd_pdf(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str).unwrap_or("") {
        "render" => {
            let json_path = args.get(1).ok_or("usage: auto pdf render <doc.json> <out.pdf>")?;
            let out_path = args.get(2).ok_or("usage: auto pdf render <doc.json> <out.pdf>")?;
            let doc: Document = serde_json::from_slice(&std::fs::read(json_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let pdf = docs::render(&doc).map_err(|e| e.to_string())?;
            std::fs::write(out_path, pdf).map_err(|e| e.to_string())?;
            Ok(())
        }
        "count" => {
            let path = args.get(1).ok_or("usage: auto pdf count <file.pdf>")?;
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            println!("{}", files::pdf_page_count(&bytes).map_err(|e| e.to_string())?);
            Ok(())
        }
        "text" => {
            let path = args.get(1).ok_or("usage: auto pdf text <file.pdf>")?;
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            for page in files::pdf_text(&bytes).map_err(|e| e.to_string())? {
                println!("{page}");
            }
            Ok(())
        }
        other => Err(format!("unknown pdf subcommand: {other}")),
    }
}

fn cmd_facturx(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str).unwrap_or("") {
        "generate" => {
            let json_path = args.get(1).ok_or("usage: auto facturx generate <doc.json> <out.pdf>")?;
            let out_path = args.get(2).ok_or("usage: auto facturx generate <doc.json> <out.pdf>")?;
            let doc: Document = serde_json::from_slice(&std::fs::read(json_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let pdf = docs::render(&doc).map_err(|e| e.to_string())?;
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(1_792_663_200);
            let fx = facturx::generate(&doc, &pdf, secs).map_err(|e| e.to_string())?;
            std::fs::write(out_path, fx).map_err(|e| e.to_string())?;
            Ok(())
        }
        "extract-xml" => {
            let path = args.get(1).ok_or("usage: auto facturx extract-xml <file.pdf>")?;
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            println!("{}", facturx::extract_xml(&bytes).map_err(|e| e.to_string())?.unwrap_or_default());
            Ok(())
        }
        "verify-pdfa" => {
            let path = args.get(1).ok_or("usage: auto facturx verify-pdfa <file.pdf>")?;
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let v = facturx::verify_pdfa(&bytes).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
            Ok(())
        }
        other => Err(format!("unknown facturx subcommand: {other}")),
    }
}

fn cmd_docx(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str).unwrap_or("") {
        "fields" => {
            let path = args.get(1).ok_or("usage: auto docx fields <file.docx>")?;
            let fields = files::template_fields_docx(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&fields).map_err(|e| e.to_string())?);
            Ok(())
        }
        "to-pdf" => {
            let path = args.get(1).ok_or("usage: auto docx to-pdf <file.docx> <out.pdf>")?;
            let out = args.get(2).ok_or("usage: auto docx to-pdf <file.docx> <out.pdf>")?;
            let pdf =
                files::docx_to_pdf(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            std::fs::write(out, pdf).map_err(|e| e.to_string())?;
            Ok(())
        }
        other => Err(format!("unknown docx subcommand: {other}")),
    }
}
