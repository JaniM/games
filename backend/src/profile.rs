//! What a user shows other players: a name. A guest chooses it (or has none), and clients show it
//! with a guest indicator. A registered user's name is their username (see `account`), which
//! can't be changed here.

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth::{AuthSession, AuthUser, touch_session},
    error::ApiError,
    room::Rooms,
};

/// Matches the `CHECK` on `users.name`. Counted in characters, not bytes.
const MAX_NAME_CHARS: usize = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    user_id: Uuid,
    /// What other players see: the username of an account, a guest's own choice, or null for a
    /// guest who hasn't picked one.
    name: Option<String>,
    /// The name an account signs in with, which is also its `name`; null for a guest.
    username: Option<String>,
}

/// `GET /api/me`: the authenticated user. Clients can use it to check that a
/// stored token still works. It is also what keeps a session from expiring (see
/// `auth::SESSION_LIFETIME`): the site calls it whenever it opens.
pub async fn me(
    AuthSession { user_id, session }: AuthSession,
    State(pool): State<PgPool>,
) -> Result<Json<Me>, ApiError> {
    if let Some(session) = session {
        touch_session(&pool, &session).await?;
    }
    let (name, username): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT name, username FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .map_err(ApiError::database("could not read a user"))?;
    Ok(Json(Me {
        user_id,
        name,
        username,
    }))
}

#[derive(Deserialize)]
pub struct NewName {
    name: String,
}

/// `PATCH /api/me` with `{ "name": "..." }`: sets a guest's name. Surrounding
/// whitespace is dropped. Answers 422 if what is left isn't 1 to 32 characters
/// without control characters, and 409 for an account, whose name is its username. Returns the
/// updated user. Games the user is playing show the new name to the other players and watchers
/// at once.
pub async fn set_name(
    AuthUser(user_id): AuthUser,
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
    Json(body): Json<NewName>,
) -> Result<Json<Me>, ApiError> {
    let name = clean_name(&body.name).ok_or(ApiError::Invalid(
        "name must be 1 to 32 characters, without control characters",
    ))?;
    let changed = sqlx::query("UPDATE users SET name = $2 WHERE id = $1 AND username IS NULL")
        .bind(user_id)
        .bind(name)
        .execute(&pool)
        .await
        .map_err(ApiError::database("could not set a user's name"))?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::Conflict(
            "the name of an account is its username, and can't be changed",
        ));
    }
    // Only now, so that the rooms read the new name.
    rooms.name_changed(user_id);
    Ok(Json(Me {
        user_id,
        name: Some(name.to_owned()),
        username: None,
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
    async fn an_account_cannot_change_its_name_which_is_its_username(pool: PgPool) {
        let app = crate::test_util::TestApp::new(pool.clone(), crate::game::Games::default());
        let (_, session) = app.register_account("Ada", "correct horse").await;

        let reply = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(&session)),
                Some(json!({ "name": "Countess" })),
            )
            .await;

        assert_eq!(reply.status, StatusCode::CONFLICT);
        let me = app
            .send(Method::GET, "/api/me", Some(&bearer(&session)), None)
            .await;
        assert_eq!(me.json["name"], "Ada");
        assert_eq!(me.json["username"], "Ada");
    }

    #[sqlx::test]
    async fn a_guest_can_still_pick_any_name_even_one_an_account_has(pool: PgPool) {
        let app = crate::test_util::TestApp::new(pool.clone(), crate::game::Games::default());
        app.register_account("Ada", "correct horse").await;
        let (_, guest) = app.register_user().await;

        let reply = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(&guest)),
                Some(json!({ "name": "Ada" })),
            )
            .await;

        // Two users called Ada: the clients tell them apart by the guest indicator.
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["name"], "Ada");
        assert_eq!(reply.json["username"], serde_json::Value::Null);
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
        assert_eq!(
            reply.json,
            json!({ "userId": user_id, "name": "Ada", "username": null })
        );

        let reply = get_me(&pool, &token).await;
        assert_eq!(
            reply.json,
            json!({ "userId": user_id, "name": "Ada", "username": null })
        );
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
