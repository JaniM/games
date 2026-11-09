//! Who a request is from. The site registers every new browser as an anonymous user (a
//! "guest") and hands it an access token. A guest can later make an account (see `account`),
//! which signs in with sessions instead. Either way the client sends its token as
//! `Authorization: Bearer <token>`. A WebSocket can't carry that header from a browser, so it
//! sends the token in its first message instead (see `socket`).
//!
//! A token is 32 random bytes, hex-encoded. A guest's is stored as given, in
//! `users.access_token`. A session's is stored as its SHA-256 (`sessions.token_hash`), so a copy
//! of the table opens no account. A session that hasn't been seen for [`SESSION_LIFETIME`]
//! doesn't count any more: `GET /api/me` is what sees it (see `profile`), and the site reads
//! the profile whenever it opens. Guests never expire.

use std::time::Duration;

use axum::{
    Json,
    extract::{FromRef, FromRequestParts, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgExecutor, PgPool};
use uuid::Uuid;

use crate::error::ApiError;

const TOKEN_BYTES: usize = 32;

/// How long a session may go unseen before it stops working.
pub const SESSION_LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    user_id: Uuid,
    access_token: String,
}

/// `POST /api/register`: creates a guest and returns its id with a fresh access token.
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

/// What identifies a session in `sessions`: the SHA-256 of its token.
pub struct SessionKey(Vec<u8>);

impl SessionKey {
    fn of(token: &str) -> Self {
        Self(Sha256::digest(token.as_bytes()).as_slice().to_vec())
    }
}

/// The user a request's access token belongs to. Add it as a handler argument to
/// require authentication; the request is rejected with 401 before the handler runs.
pub struct AuthUser(pub Uuid);

impl<S> FromRequestParts<S> for AuthUser
where
    PgPool: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        let token = bearer_token(&parts.headers).ok_or(ApiError::Unauthorized)?;
        lookup(&PgPool::from_ref(state), token)
            .await
            .map(|identity| Self(identity.user_id))
    }
}

/// [`AuthUser`] that also says which session the token is, for a handler that has to do
/// something to it. `session` is `None` for a guest's token, which is not a session.
pub struct AuthSession {
    pub user_id: Uuid,
    pub session: Option<SessionKey>,
}

impl<S> FromRequestParts<S> for AuthSession
where
    PgPool: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        let token = bearer_token(&parts.headers).ok_or(ApiError::Unauthorized)?;
        lookup(&PgPool::from_ref(state), token)
            .await
            .map(|identity| Self {
                user_id: identity.user_id,
                session: identity.session,
            })
    }
}

/// The user an access token belongs to, or `Unauthorized` if no user has it. For
/// callers that get the token some other way than the `Authorization` header.
pub async fn authenticate(pool: &PgPool, token: &str) -> Result<Uuid, ApiError> {
    lookup(pool, token).await.map(|identity| identity.user_id)
}

struct Identity {
    user_id: Uuid,
    session: Option<SessionKey>,
}

/// A guest's token is found in `users`, a session's in `sessions` (if it hasn't expired).
async fn lookup(pool: &PgPool, token: &str) -> Result<Identity, ApiError> {
    let key = SessionKey::of(token);
    let found: Option<(Uuid, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT id, NULL::bytea FROM users WHERE access_token = $1
         UNION ALL
         SELECT user_id, token_hash FROM sessions
          WHERE token_hash = $2 AND last_seen_at > now() - make_interval(secs => $3)",
    )
    .bind(token)
    .bind(&key.0)
    .bind(SESSION_LIFETIME.as_secs_f64())
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database("could not look up an access token"))?;
    found
        .map(|(user_id, session)| Identity {
            user_id,
            session: session.map(SessionKey),
        })
        .ok_or(ApiError::Unauthorized)
}

/// Signs `user_id` in on one more browser. Returns the session's token, which is not kept: only
/// its hash is.
pub async fn create_session<'c>(
    executor: impl PgExecutor<'c>,
    user_id: Uuid,
) -> Result<String, ApiError> {
    let token = new_token()?;
    sqlx::query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)")
        .bind(SessionKey::of(&token).0)
        .bind(user_id)
        .execute(executor)
        .await
        .map_err(ApiError::database("could not make a session"))?;
    Ok(token)
}

/// Records that the session was in use just now, which keeps it from expiring.
pub async fn touch_session(pool: &PgPool, session: &SessionKey) -> Result<(), ApiError> {
    sqlx::query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1")
        .bind(&session.0)
        .execute(pool)
        .await
        .map_err(ApiError::database("could not update a session"))?;
    Ok(())
}

/// Signs the session out. The token stops working at once.
pub async fn end_session(pool: &PgPool, session: &SessionKey) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(&session.0)
        .execute(pool)
        .await
        .map_err(ApiError::database("could not end a session"))?;
    Ok(())
}

/// Deletes the sessions that have expired. They are already refused, so this only keeps the
/// table from growing; sign-in does it, which is often enough.
pub async fn sweep_expired_sessions<'c>(executor: impl PgExecutor<'c>) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM sessions WHERE last_seen_at <= now() - make_interval(secs => $1)")
        .bind(SESSION_LIFETIME.as_secs_f64())
        .execute(executor)
        .await
        .map_err(ApiError::database("could not sweep expired sessions"))?;
    Ok(())
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
