//! Anonymous accounts. The site registers every new browser as a user and hands
//! it an access token, which the client then sends as `Authorization: Bearer <token>`.
//!
//! The token is 32 random bytes, hex-encoded, and is stored as given.

use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

const TOKEN_BYTES: usize = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    user_id: Uuid,
    access_token: String,
}

/// `POST /api/register`: creates a user and returns its id with a fresh access token.
pub async fn register(
    State(pool): State<PgPool>,
) -> Result<(StatusCode, Json<Registration>), ApiError> {
    let access_token = new_token()?;
    let user_id: Uuid =
        sqlx::query_scalar("INSERT INTO users (access_token) VALUES ($1) RETURNING id")
            .bind(&access_token)
            .fetch_one(&pool)
            .await
            .map_err(ApiError::database("could not register a user"))?;
    Ok((
        StatusCode::CREATED,
        Json(Registration {
            user_id,
            access_token,
        }),
    ))
}

/// The user a request's access token belongs to. Add it as a handler argument to
/// require authentication; the request is rejected with 401 before the handler runs.
pub struct AuthUser(pub Uuid);

impl FromRequestParts<PgPool> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, pool: &PgPool) -> Result<Self, ApiError> {
        let token = bearer_token(&parts.headers).ok_or(ApiError::Unauthorized)?;
        let user_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE access_token = $1")
                .bind(token)
                .fetch_optional(pool)
                .await
                .map_err(ApiError::database("could not look up an access token"))?;
        user_id.map(Self).ok_or(ApiError::Unauthorized)
    }
}

fn new_token() -> Result<String, ApiError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|err| {
        tracing::error!(%err, "system random source failed");
        ApiError::Internal
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The token from an `Authorization: Bearer <token>` header. The scheme name is
/// case-insensitive (RFC 9110).
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("Bearer") && !token.is_empty()).then_some(token)
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use sqlx::postgres::PgPoolOptions;

    use super::*;
    use crate::test_util::{bearer, register_user, send};

    async fn get_me(pool: &PgPool, authorization: Option<&str>) -> crate::test_util::Reply {
        send(pool, Method::GET, "/api/me", authorization, None).await
    }

    #[sqlx::test]
    async fn register_returns_a_user_id_and_a_hex_token(pool: PgPool) {
        let (user_id, token) = register_user(&pool).await;

        assert!(user_id.parse::<Uuid>().is_ok(), "not a uuid: {user_id}");
        assert_eq!(token.len(), TOKEN_BYTES * 2);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[sqlx::test]
    async fn every_registration_gets_its_own_id_and_token(pool: PgPool) {
        let (id_a, token_a) = register_user(&pool).await;
        let (id_b, token_b) = register_user(&pool).await;

        assert_ne!(id_a, id_b);
        assert_ne!(token_a, token_b);
    }

    #[sqlx::test]
    async fn the_registered_token_authenticates_as_that_user(pool: PgPool) {
        let (user_id, token) = register_user(&pool).await;

        let reply = get_me(&pool, Some(&bearer(&token))).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["userId"], user_id.as_str());
    }

    #[sqlx::test]
    async fn the_bearer_scheme_is_case_insensitive(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        let reply = get_me(&pool, Some(&format!("bearer {token}"))).await;

        assert_eq!(reply.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn a_missing_token_is_unauthorized_and_names_the_scheme(pool: PgPool) {
        let reply = get_me(&pool, None).await;

        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.headers[header::WWW_AUTHENTICATE], "Bearer");
    }

    #[sqlx::test]
    async fn an_unknown_token_is_unauthorized(pool: PgPool) {
        register_user(&pool).await;

        let reply = get_me(&pool, Some(&bearer(&"0".repeat(TOKEN_BYTES * 2)))).await;

        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn other_schemes_and_empty_tokens_are_unauthorized(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        for value in [format!("Basic {token}"), "Bearer ".to_owned(), token] {
            let reply = get_me(&pool, Some(&value)).await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{value:?}");
        }
    }

    // A lazy pool never connects, so these run without a database.
    async fn closed_pool() -> PgPool {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        pool.close().await;
        pool
    }

    #[tokio::test]
    async fn register_fails_with_500_when_the_database_is_down() {
        let pool = closed_pool().await;

        let reply = send(&pool, Method::POST, "/api/register", None, None).await;

        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn authentication_fails_with_500_when_the_database_is_down() {
        let pool = closed_pool().await;

        let reply = get_me(&pool, Some("Bearer abc")).await;

        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
