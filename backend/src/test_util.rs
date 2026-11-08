//! Helpers for tests that drive the whole app through its router.

use axum::{
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

use crate::app;

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    /// The JSON body, or `Null` if there isn't one.
    pub json: Value,
}

/// Sends one request. `authorization` is the whole header value, e.g. `Bearer abc`.
pub async fn send(
    pool: &PgPool,
    method: Method,
    uri: &str,
    authorization: Option<&str>,
    json: Option<Value>,
) -> Reply {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(value) = authorization {
        builder = builder.header(header::AUTHORIZATION, value);
    }
    let body = match json {
        Some(json) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let response = app(pool.clone())
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    Reply {
        status: parts.status,
        headers: parts.headers,
        json: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

/// Registers a user. Returns its id and access token.
pub async fn register_user(pool: &PgPool) -> (String, String) {
    let reply = send(pool, Method::POST, "/api/register", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    (
        reply.json["userId"].as_str().unwrap().to_owned(),
        reply.json["accessToken"].as_str().unwrap().to_owned(),
    )
}

pub fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}
