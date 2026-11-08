//! What a user chooses to show other players. For now that is a display name.

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{auth::AuthUser, error::ApiError};

/// Matches the `CHECK` on `users.name`. Counted in characters, not bytes.
const MAX_NAME_CHARS: usize = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    user_id: Uuid,
    /// Null until the user picks one.
    name: Option<String>,
}

/// `GET /api/me`: the authenticated user. Clients can use it to check that a
/// stored token still works.
pub async fn me(
    AuthUser(user_id): AuthUser,
    State(pool): State<PgPool>,
) -> Result<Json<Me>, ApiError> {
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .map_err(ApiError::database("could not read a user's name"))?;
    Ok(Json(Me { user_id, name }))
}

#[derive(Deserialize)]
pub struct NewName {
    name: String,
}

/// `PATCH /api/me` with `{ "name": "..." }`: sets the display name. Surrounding
/// whitespace is dropped. Answers 422 if what is left isn't 1 to 32 characters
/// without control characters. Returns the updated user.
pub async fn set_name(
    AuthUser(user_id): AuthUser,
    State(pool): State<PgPool>,
    Json(body): Json<NewName>,
) -> Result<Json<Me>, ApiError> {
    let name = clean_name(&body.name).ok_or(ApiError::Invalid(
        "name must be 1 to 32 characters, without control characters",
    ))?;
    sqlx::query("UPDATE users SET name = $2 WHERE id = $1")
        .bind(user_id)
        .bind(name)
        .execute(&pool)
        .await
        .map_err(ApiError::database("could not set a user's name"))?;
    Ok(Json(Me {
        user_id,
        name: Some(name.to_owned()),
    }))
}

fn clean_name(raw: &str) -> Option<&str> {
    let name = raw.trim();
    let length = name.chars().count();
    ((1..=MAX_NAME_CHARS).contains(&length) && !name.chars().any(char::is_control)).then_some(name)
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::test_util::{Reply, bearer, register_user, send};

    async fn patch_name(pool: &PgPool, token: &str, body: serde_json::Value) -> Reply {
        send(
            pool,
            Method::PATCH,
            "/api/me",
            Some(&bearer(token)),
            Some(body),
        )
        .await
    }

    async fn get_me(pool: &PgPool, token: &str) -> Reply {
        send(pool, Method::GET, "/api/me", Some(&bearer(token)), None).await
    }

    #[sqlx::test]
    async fn a_new_user_has_no_name(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        let reply = get_me(&pool, &token).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["name"], serde_json::Value::Null);
    }

    #[sqlx::test]
    async fn the_name_is_saved_and_returned(pool: PgPool) {
        let (user_id, token) = register_user(&pool).await;

        let reply = patch_name(&pool, &token, json!({ "name": "Ada" })).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json, json!({ "userId": user_id, "name": "Ada" }));

        let reply = get_me(&pool, &token).await;
        assert_eq!(reply.json, json!({ "userId": user_id, "name": "Ada" }));
    }

    #[sqlx::test]
    async fn the_name_can_be_changed(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        patch_name(&pool, &token, json!({ "name": "Ada" })).await;
        patch_name(&pool, &token, json!({ "name": "Grace" })).await;

        assert_eq!(get_me(&pool, &token).await.json["name"], "Grace");
    }

    #[sqlx::test]
    async fn names_belong_to_their_own_user(pool: PgPool) {
        let (_, token_a) = register_user(&pool).await;
        let (_, token_b) = register_user(&pool).await;

        patch_name(&pool, &token_a, json!({ "name": "Ada" })).await;

        assert_eq!(
            get_me(&pool, &token_b).await.json["name"],
            serde_json::Value::Null
        );
    }

    #[sqlx::test]
    async fn surrounding_whitespace_is_dropped(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        let reply = patch_name(&pool, &token, json!({ "name": "  Ada Lovelace \n" })).await;

        assert_eq!(reply.json["name"], "Ada Lovelace");
        assert_eq!(get_me(&pool, &token).await.json["name"], "Ada Lovelace");
    }

    #[sqlx::test]
    async fn the_limit_counts_characters_not_bytes(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        let longest = "ä".repeat(MAX_NAME_CHARS);
        let reply = patch_name(&pool, &token, json!({ "name": longest })).await;
        assert_eq!(reply.status, StatusCode::OK);

        let too_long = "ä".repeat(MAX_NAME_CHARS + 1);
        let reply = patch_name(&pool, &token, json!({ "name": too_long })).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(get_me(&pool, &token).await.json["name"], longest);
    }

    #[sqlx::test]
    async fn unacceptable_names_are_rejected_and_change_nothing(pool: PgPool) {
        let (_, token) = register_user(&pool).await;
        patch_name(&pool, &token, json!({ "name": "Ada" })).await;

        for name in ["", "   ", "a\u{0}b", "line\nbreak"] {
            let reply = patch_name(&pool, &token, json!({ "name": name })).await;
            assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{name:?}");
        }
        assert_eq!(get_me(&pool, &token).await.json["name"], "Ada");
    }

    #[sqlx::test]
    async fn a_body_without_a_name_is_rejected(pool: PgPool) {
        let (_, token) = register_user(&pool).await;

        let reply = patch_name(&pool, &token, json!({ "nom": "Ada" })).await;

        assert!(reply.status.is_client_error(), "{}", reply.status);
    }

    #[sqlx::test]
    async fn setting_a_name_needs_a_known_token(pool: PgPool) {
        let reply = send(
            &pool,
            Method::PATCH,
            "/api/me",
            None,
            Some(json!({ "name": "Ada" })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

        let reply = patch_name(&pool, "unknown", json!({ "name": "Ada" })).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
}
