//! HTTP API server — exposes /api/* endpoints for scripts on iPhone to query emails.

use std::sync::Arc;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;
use tracing::info;

use super::MailServerState;

#[derive(Deserialize)]
pub struct EmailsQuery {
    pub to: Option<String>,
    pub from: Option<String>,
    pub subject: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct LatestQuery {
    pub to: String,
    pub format: Option<String>,
}

#[derive(Deserialize)]
pub struct DetailQuery {
    pub format: Option<String>,
}

#[derive(Serialize)]
struct StatusResponse {
    status: String,
    imap_connected: bool,
    imap_user: String,
    total_emails_cached: usize,
    max_cache: usize,
    tunnel_url: Option<String>,
    last_check: Option<String>,
}

#[derive(Serialize)]
struct EmailListResponse {
    count: usize,
    emails: Vec<EmailSummary>,
}

#[derive(Serialize)]
struct EmailSummary {
    id: String,
    to: Vec<String>,
    hide_my_email: String,
    from: String,
    subject: String,
    date: String,
    received_at: String,
}

#[derive(Serialize)]
struct EmailDetail {
    id: String,
    to: Vec<String>,
    hide_my_email: String,
    from: String,
    subject: String,
    date: String,
    received_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Serialize)]
struct AliasInfo {
    address: String,
    email_count: usize,
    latest_date: String,
}

#[derive(Serialize)]
struct AliasesResponse {
    count: usize,
    aliases: Vec<AliasInfo>,
}

/// Start the HTTP API server on the configured port.
pub async fn run(state: Arc<MailServerState>, port: u16) {
    let app = Router::new()
        .route("/api/status", get(status_handler))
        .route("/api/emails", get(emails_handler))
        .route("/api/email/{id}", get(email_detail_handler))
        .route("/api/latest", get(latest_handler))
        .route("/api/aliases", get(aliases_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0], port));
    info!("Mail HTTP API listening on [::]:{}", port);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn status_handler(State(state): State<Arc<MailServerState>>) -> Json<StatusResponse> {
    let config = state.config.read();
    Json(StatusResponse {
        status: "running".to_string(),
        imap_connected: *state.imap_connected.read(),
        imap_user: config.as_ref().map(|c| c.imap_user.clone()).unwrap_or_default(),
        total_emails_cached: state.emails.read().len(),
        max_cache: config.as_ref().map(|c| c.max_emails).unwrap_or(500),
        tunnel_url: state.public_url.read().clone(),
        last_check: state.last_check.read().clone(),
    })
}

async fn emails_handler(
    State(state): State<Arc<MailServerState>>,
    Query(params): Query<EmailsQuery>,
) -> Json<EmailListResponse> {
    let emails = state.emails.read();
    let limit = params.limit.unwrap_or(50);

    let filtered: Vec<EmailSummary> = emails
        .iter()
        .filter(|e| {
            if let Some(ref to) = params.to {
                if !e.to.iter().any(|a| a.eq_ignore_ascii_case(to))
                    && !e.hide_my_email.eq_ignore_ascii_case(to)
                {
                    return false;
                }
            }
            if let Some(ref from) = params.from {
                if !e.from.to_lowercase().contains(&from.to_lowercase()) {
                    return false;
                }
            }
            if let Some(ref subject) = params.subject {
                if !e.subject.to_lowercase().contains(&subject.to_lowercase()) {
                    return false;
                }
            }
            true
        })
        .take(limit)
        .map(|e| EmailSummary {
            id: e.id.clone(),
            to: e.to.clone(),
            hide_my_email: e.hide_my_email.clone(),
            from: e.from.clone(),
            subject: e.subject.clone(),
            date: e.date.clone(),
            received_at: e.received_at.clone(),
        })
        .collect();

    Json(EmailListResponse {
        count: filtered.len(),
        emails: filtered,
    })
}

async fn email_detail_handler(
    State(state): State<Arc<MailServerState>>,
    Path(id): Path<String>,
    Query(params): Query<DetailQuery>,
) -> Result<Json<EmailDetail>, StatusCode> {
    let emails = state.emails.read();
    let email = emails.iter().find(|e| e.id == id).ok_or(StatusCode::NOT_FOUND)?;
    let format = params.format.as_deref().unwrap_or("all");

    Ok(Json(EmailDetail {
        id: email.id.clone(),
        to: email.to.clone(),
        hide_my_email: email.hide_my_email.clone(),
        from: email.from.clone(),
        subject: email.subject.clone(),
        date: email.date.clone(),
        received_at: email.received_at.clone(),
        body_text: if format == "all" || format == "text" { Some(email.body_text.clone()) } else { None },
        body_html: if format == "all" || format == "html" { Some(email.body_html.clone()) } else { None },
        body: if format == "text" {
            Some(email.body_text.clone())
        } else if format == "html" {
            Some(email.body_html.clone())
        } else {
            None
        },
    }))
}

async fn latest_handler(
    State(state): State<Arc<MailServerState>>,
    Query(params): Query<LatestQuery>,
) -> Result<Json<EmailDetail>, (StatusCode, Json<serde_json::Value>)> {
    let emails = state.emails.read();
    let email = emails
        .iter()
        .find(|e| {
            e.to.iter().any(|a| a.eq_ignore_ascii_case(&params.to))
                || e.hide_my_email.eq_ignore_ascii_case(&params.to)
        })
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("No email found for: {}", params.to)})),
            )
        })?;

    let format = params.format.as_deref().unwrap_or("all");

    Ok(Json(EmailDetail {
        id: email.id.clone(),
        to: email.to.clone(),
        hide_my_email: email.hide_my_email.clone(),
        from: email.from.clone(),
        subject: email.subject.clone(),
        date: email.date.clone(),
        received_at: email.received_at.clone(),
        body_text: if format == "all" || format == "text" { Some(email.body_text.clone()) } else { None },
        body_html: if format == "all" || format == "html" { Some(email.body_html.clone()) } else { None },
        body: if format == "text" {
            Some(email.body_text.clone())
        } else if format == "html" {
            Some(email.body_html.clone())
        } else {
            None
        },
    }))
}

async fn aliases_handler(State(state): State<Arc<MailServerState>>) -> Json<AliasesResponse> {
    let emails = state.emails.read();
    let mut alias_map: std::collections::HashMap<String, (usize, String)> = std::collections::HashMap::new();

    for email in emails.iter() {
        let addr = email.hide_my_email.to_lowercase();
        if addr.is_empty() {
            continue;
        }
        let entry = alias_map.entry(addr).or_insert((0, String::new()));
        entry.0 += 1;
        if entry.1.is_empty() || email.received_at > entry.1 {
            entry.1 = email.received_at.clone();
        }
    }

    let mut aliases: Vec<AliasInfo> = alias_map
        .into_iter()
        .map(|(addr, (count, latest))| AliasInfo {
            address: addr,
            email_count: count,
            latest_date: latest,
        })
        .collect();
    aliases.sort_by(|a, b| b.latest_date.cmp(&a.latest_date));

    Json(AliasesResponse {
        count: aliases.len(),
        aliases,
    })
}
