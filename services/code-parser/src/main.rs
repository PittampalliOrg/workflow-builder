mod model;
mod metadata;
mod python;
mod schema;
mod typescript;

use std::collections::HashMap;
use std::net::SocketAddr;

use axum::{extract::Json, http::StatusCode, response::IntoResponse, routing::{get, post}, Router};
use model::{
    BatchParseRequest, BatchParseResponse, Diagnostic, DiagnosticSeverity, ImportKind, Language,
    ParseRequest, ParseResponse,
};
use tokio::net::TcpListener;
use tracing::Level;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(Level::INFO)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8080);
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

    let app = Router::new()
        .route("/health", get(health))
        .route("/parse/file", post(parse_file))
        .route("/parse/preview", post(parse_file))
        .route("/parse/batch", post(parse_batch));

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!("code-parser listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn parse_file(Json(request): Json<ParseRequest>) -> Result<Json<ParseResponse>, ApiError> {
    let model = parse_request(&request)?;
    Ok(Json(ParseResponse { model }))
}

async fn parse_batch(
    Json(request): Json<BatchParseRequest>,
) -> Result<Json<BatchParseResponse>, ApiError> {
    let items = request
        .items
        .iter()
        .map(parse_request)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(BatchParseResponse { items }))
}

fn parse_request(request: &ParseRequest) -> Result<model::CodeFunctionModel, ApiError> {
    let mut model = match request.language {
        Language::Typescript => {
            typescript::parse_typescript(
                &request.source,
                request.entrypoint.as_deref(),
                request.path.as_deref(),
                &request.supporting_files,
            )
        }
        Language::Python => {
            python::parse_python(
                &request.source,
                request.entrypoint.as_deref(),
                request.path.as_deref(),
                &request.supporting_files,
            )
        }
    }
    .map_err(ApiError::from)?;

    model
        .diagnostics
        .extend(validate_local_imports(request.language, &model.imports, &request.supporting_files));

    Ok(model)
}

fn validate_local_imports(
    language: Language,
    imports: &[model::ImportRef],
    supporting_files: &HashMap<String, String>,
) -> Vec<Diagnostic> {
    let available = supporting_files.keys().cloned().collect::<std::collections::HashSet<_>>();
    imports
        .iter()
        .filter(|item| matches!(item.kind, ImportKind::Local))
        .filter_map(|item| {
            let resolved_path = item.resolved_path.as_deref()?;
            let candidates = local_import_candidates(language, resolved_path);
            if candidates.iter().any(|candidate| available.contains(candidate)) {
                return None;
            }
            Some(Diagnostic {
                severity: DiagnosticSeverity::Warning,
                message: format!(
                    "Local import `{}` is not covered by supporting_files. Expected one of: {}",
                    item.specifier,
                    candidates.join(", ")
                ),
            })
        })
        .collect()
}

fn local_import_candidates(language: Language, resolved_path: &str) -> Vec<String> {
    match language {
        Language::Typescript => [
            format!("{resolved_path}.ts"),
            format!("{resolved_path}.tsx"),
            format!("{resolved_path}.js"),
            format!("{resolved_path}.mjs"),
            format!("{resolved_path}.cjs"),
            format!("{resolved_path}/index.ts"),
            format!("{resolved_path}/index.tsx"),
            format!("{resolved_path}/index.js"),
            format!("{resolved_path}/index.mjs"),
            format!("{resolved_path}/index.cjs"),
        ]
        .into_iter()
        .collect(),
        Language::Python => [
            format!("{resolved_path}.py"),
            format!("{resolved_path}/__init__.py"),
        ]
        .into_iter()
        .collect(),
    }
}

struct ApiError(anyhow::Error);

impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        Self(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": self.0.to_string(),
            })),
        )
            .into_response()
    }
}
