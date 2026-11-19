// Native Rust JSON-RPC 2.0 MCP router (stdio + HTTP) for external agents and IDEs.
use auto_auth::{
    password::{hash_password, verify_password},
    rbac::{Action, Role, can_perform},
};
use auto_facturx::{generate as generate_facturx, verify_pdfa, xml as facturx_xml};
use auto_knowledge::chunk_text;
use auto_model::Document;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub fn mcp_tools_manifest() -> Vec<Value> {
    vec![
        json!({
            "name": "facturx_xml",
            "description": "Generate EN 16931 CrossIndustryInvoice CII XML from an Invoice/Document JSON.",
            "inputSchema": { "type": "object", "properties": { "document": { "type": "object" } }, "required": ["document"] }
        }),
        json!({
            "name": "verify_pdfa_base64",
            "description": "Verify Factur-X PDF/A-3b conformance of a base64-encoded PDF.",
            "inputSchema": { "type": "object", "properties": { "pdfBase64": { "type": "string" } }, "required": ["pdfBase64"] }
        }),
        json!({
            "name": "render_facturx_pdf",
            "description": "Render an Invoice JSON into a PDF/A-3b Factur-X PDF (base64).",
            "inputSchema": { "type": "object", "properties": { "document": { "type": "object" }, "unixSecs": { "type": "integer" } }, "required": ["document"] }
        }),
        json!({
            "name": "chunk_text",
            "description": "Split prose or markdown into RAG-ready semantic chunks.",
            "inputSchema": { "type": "object", "properties": { "source": { "type": "string" }, "text": { "type": "string" }, "chunkSize": { "type": "integer" } }, "required": ["source", "text"] }
        }),
        json!({
            "name": "auth_hash_password",
            "description": "Hash a password using modern Argon2id PHC.",
            "inputSchema": { "type": "object", "properties": { "password": { "type": "string" } }, "required": ["password"] }
        }),
        json!({
            "name": "auth_verify_password",
            "description": "Verify a password against an Argon2id or Better Auth Scrypt hash.",
            "inputSchema": { "type": "object", "properties": { "password": { "type": "string" }, "hash": { "type": "string" } }, "required": ["password", "hash"] }
        }),
        json!({
            "name": "auth_check_rbac",
            "description": "Check whether an organization role can perform a given action.",
            "inputSchema": { "type": "object", "properties": { "role": { "type": "string" }, "action": { "type": "string" } }, "required": ["role", "action"] }
        }),
    ]
}

pub fn handle_mcp_request(req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or_default();
    if method == "notifications/initialized" {
        return None;
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "aphrody-auto-native", "version": crate::VERSION }
            }
        })),
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": mcp_tools_manifest() }
        })),
        "tools/call" => {
            let params = req.get("params").and_then(|v| v.as_object());
            let name = params.and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or_default();
            let args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or_else(|| json!({}));
            match dispatch_tool(name, &args) {
                Ok(val) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [{ "type": "text", "text": serde_json::to_string_pretty(&val).unwrap_or_default() }] }
                })),
                Err(msg) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "isError": true, "content": [{ "type": "text", "text": msg }] }
                })),
            }
        }
        other => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {other}") }
        })),
    }
}

fn dispatch_tool(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "facturx_xml" => {
            let doc: Document = serde_json::from_value(args["document"].clone()).map_err(|e| e.to_string())?;
            let xml = facturx_xml(&doc).map_err(|e| e.to_string())?;
            Ok(json!({ "xml": xml }))
        }
        "render_facturx_pdf" => {
            let doc: Document = serde_json::from_value(args["document"].clone()).map_err(|e| e.to_string())?;
            let pdf = auto_docs::render(&doc).map_err(|e| e.to_string())?;
            let unix = args["unixSecs"].as_i64().unwrap_or(1_792_663_200);
            let fx = generate_facturx(&doc, &pdf, unix).map_err(|e| e.to_string())?;
            Ok(json!({ "pdfBase64": STANDARD.encode(&fx), "bytes": fx.len() }))
        }
        "verify_pdfa_base64" => {
            let b64 = args["pdfBase64"].as_str().ok_or("missing pdfBase64")?;
            let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
            let violations = verify_pdfa(&bytes).map_err(|e| e.to_string())?;
            Ok(json!({ "valid": violations.is_empty(), "violations": violations }))
        }
        "chunk_text" => {
            let src = args["source"].as_str().ok_or("missing source")?;
            let text = args["text"].as_str().ok_or("missing text")?;
            let size = args["chunkSize"].as_u64().map(|n| n as usize);
            let chunks = chunk_text(src, text, size).map_err(|e| e.to_string())?;
            serde_json::to_value(chunks).map_err(|e| e.to_string())
        }
        "auth_hash_password" => {
            let pw = args["password"].as_str().ok_or("missing password")?;
            let hash = hash_password(pw).map_err(|e| e.to_string())?;
            Ok(json!({ "hash": hash }))
        }
        "auth_verify_password" => {
            let pw = args["password"].as_str().ok_or("missing password")?;
            let hash = args["hash"].as_str().ok_or("missing hash")?;
            let valid = verify_password(pw, hash).map_err(|e| e.to_string())?;
            Ok(json!({ "valid": valid }))
        }
        "auth_check_rbac" => {
            let role = Role::parse(args["role"].as_str().ok_or("missing role")?).map_err(|e| e.to_string())?;
            let action: Action = serde_json::from_value(args["action"].clone()).map_err(|e| e.to_string())?;
            Ok(json!({ "allowed": can_perform(role, action) }))
        }
        other => Err(format!("unknown MCP tool: {other}")),
    }
}
