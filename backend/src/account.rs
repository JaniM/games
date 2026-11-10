//! Accounts: a username and a password, so that a user can get back in from another browser.
//!
//! Everyone starts as a guest (see `auth`). `POST /api/account` turns the guest into an account
//! in place, so its games carry over, and retires the guest's access token: from then on the
//! account is only reachable with a session, which `POST /api/login` makes on any browser that
//! knows the password. A session is ended by `POST /api/logout`, and expires when unseen for
//! `auth::SESSION_LIFETIME`.
//!
//! The username is the user's name: other players see it, and nobody else can have it (names are
//! compared whatever their case). A guest's name is whatever they typed, if anything, and is
//! replaced by the username when they make an account. A registered user can't change it: it is
//! also how they sign in (see `profile`).
//!
//! Passwords are kept as argon2id hashes. Hashing takes some 20 MiB and a moment of CPU, so it
//! runs off the async threads, at most [`MAX_HASHES`] at a time, and never while a database
//! connection is held (the pool is small). A wrong password for a username is only accepted
//! [`MAX_FAILURES`] times per [`FAILURE_WINDOW`]; the count is kept in memory.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant},
};

use argon2::{
    Argon2,
    password_hash::{self, PasswordHasher, PasswordVerifier},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    auth::{AuthSession, AuthUser, create_session, end_session, sweep_expired_sessions},
    error::ApiError,
    game_id::GameId,
    room::{RoomError, Rooms},
};

/// How many passwords may be hashed at once. Each takes about 19 MiB.
const MAX_HASHES: usize = 4;

/// How many wrong passwords a username gets in a [`FAILURE_WINDOW`] before it is refused.
const MAX_FAILURES: usize = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
/// The failures of this many usernames are kept before the expired ones are dropped.
const SWEEP_AT: usize = 1000;

const USERNAME_LENGTH: std::ops::RangeInclusive<usize> = 3..=32;
const PASSWORD_LENGTH: std::ops::RangeInclusive<usize> = 8..=128;

/// What account requests share: the limit on password hashing, and the record of wrong
/// passwords. Cheap to clone.
#[derive(Clone)]
pub struct Accounts {
    hashing: Arc<Semaphore>,
    failures: Arc<Mutex<Failures>>,
}

impl Accounts {
    pub fn new() -> Self {
        Self {
            hashing: Arc::new(Semaphore::new(MAX_HASHES)),
            failures: Arc::default(),
        }
    }

    fn failures(&self) -> MutexGuard<'_, Failures> {
        // The guard is never held across anything that can panic.
        self.failures.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Runs `work` on a thread meant for blocking, once one of the [`MAX_HASHES`] places is
    /// free. The place is given back when the work is done, even if the request was dropped.
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ApiError> {
        let permit = Arc::clone(&self.hashing)
            .acquire_owned()
            .await
            .map_err(|err| {
                tracing::error!(%err, "the hashing limit was closed");
                ApiError::Internal
            })?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        })
        .await
        .map_err(|err| {
            tracing::error!(%err, "password hashing did not finish");
            ApiError::Internal
        })
    }

    async fn hash(&self, password: String) -> Result<String, ApiError> {
        self.blocking(move || {
            Argon2::default()
                .hash_password(password.as_bytes())
                .map(|hash| hash.to_string())
        })
        .await?
        .map_err(|err| {
            tracing::error!(%err, "could not hash a password");
            ApiError::Internal
        })
    }

    /// Whether `password` is the one `stored` is a hash of. With no stored hash (the username
    /// is unknown) it hashes anyway, so that the answer takes as long either way, and says no.
    async fn verify(&self, password: String, stored: Option<String>) -> Result<bool, ApiError> {
        self.blocking(move || {
            let real = stored.is_some();
            let hash = stored.as_deref().unwrap_or_else(|| decoy_hash());
            match Argon2::default().verify_password(password.as_bytes(), hash) {
                Ok(()) => real,
                Err(password_hash::Error::PasswordInvalid) => false,
                Err(err) => {
                    tracing::error!(%err, "could not check a password against its hash");
                    false
                }
            }
        })
        .await
    }
}

/// A hash that no password a person could type matches, for [`Accounts::verify`] to spend its
/// time on. Made on first use, with the same cost as a real one.
fn decoy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        Argon2::default()
            // Longer than any password the site accepts, so it can't be one.
            .hash_password(&[0u8; 2 * 128])
            .expect("the decoy password can be hashed")
            .to_string()
    })
}

/// The wrong passwords lately tried for each username (lower case), oldest first.
#[derive(Default)]
struct Failures(HashMap<String, VecDeque<Instant>>);

impl Failures {
    /// How long until `username` may try again, or `None` if it may now.
    fn wait(&mut self, username: &str, now: Instant) -> Option<Duration> {
        let recent = self.0.get_mut(username)?;
        while recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= FAILURE_WINDOW)
        {
            recent.pop_front();
        }
        let Some(oldest) = recent.front().copied() else {
            self.0.remove(username);
            return None;
        };
        // Once the oldest has expired there is room for one more.
        (recent.len() >= MAX_FAILURES).then(|| FAILURE_WINDOW - now.duration_since(oldest))
    }

    fn failed(&mut self, username: &str, now: Instant) {
        if self.0.len() >= SWEEP_AT {
            self.0.retain(|_, recent| {
                recent
                    .back()
                    .is_some_and(|at| now.duration_since(*at) < FAILURE_WINDOW)
            });
        }
        self.0
            .entry(username.to_owned())
            .or_default()
            .push_back(now);
    }

    fn cleared(&mut self, username: &str) {
        self.0.remove(username);
    }
}

/// Matches the `CHECK` on `users.username`.
fn valid_username(username: &str) -> bool {
    USERNAME_LENGTH.contains(&username.len())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// Not trimmed and with no rules about what is in it: only how long it is.
fn valid_password(password: &str) -> bool {
    PASSWORD_LENGTH.contains(&password.chars().count())
}

/// What `POST /api/account` and `POST /api/login` return: who the browser is now, and the
/// token that proves it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signed {
    user_id: Uuid,
    access_token: String,
    username: String,
}

#[derive(Deserialize)]
pub struct NewAccount {
    username: String,
    password: String,
}

/// `POST /api/account` with `{ "username": "...", "password": "..." }`, as a guest: makes the
/// guest an account, and the username their name, in place of any name they had. Answers 422 if
/// the username or the password isn't acceptable, and 409 if the username is taken (whatever its
/// case) or the user already has an account. Returns 201 with the session to use from now on:
/// the guest's access token no longer works.
pub async fn create(
    AuthUser(user_id): AuthUser,
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
    State(accounts): State<Accounts>,
    Json(body): Json<NewAccount>,
) -> Result<(StatusCode, Json<Signed>), ApiError> {
    if !valid_username(&body.username) {
        return Err(ApiError::Invalid(
            "username must be 3 to 32 letters, digits, dots, hyphens or underscores",
        ));
    }
    if !valid_password(&body.password) {
        return Err(ApiError::Invalid("password must be 8 to 128 characters"));
    }
    let hash = accounts.hash(body.password).await?;

    let mut tx = pool
        .begin()
        .await
        .map_err(ApiError::database("could not start making an account"))?;
    // The guest token goes in the same statement that makes the user an account, so there is
    // no moment at which both work (and `users_account_has_no_guest_token` insists).
    let claimed = sqlx::query(
        "UPDATE users
            SET username = $2, password_hash = $3, access_token = NULL, name = $2
          WHERE id = $1 AND password_hash IS NULL AND deleted_at IS NULL",
    )
    .bind(user_id)
    .bind(&body.username)
    .bind(&hash)
    .execute(&mut *tx)
    .await
    .map_err(|err| match err.as_database_error() {
        Some(db) if db.is_unique_violation() => ApiError::Conflict("that username is taken"),
        _ => ApiError::database("could not make an account")(err),
    })?;
    if claimed.rows_affected() == 0 {
        return Err(ApiError::Conflict("you already have an account"));
    }
    let access_token = create_session(&mut *tx, user_id).await?;
    tx.commit()
        .await
        .map_err(ApiError::database("could not make an account"))?;

    // The name is the username now, and the user is no longer a guest. Only now, so that the
    // rooms read it.
    rooms.name_changed(user_id);
    Ok((
        StatusCode::CREATED,
        Json(Signed {
            user_id,
            access_token,
            username: body.username,
        }),
    ))
}

#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}

/// `POST /api/login` with `{ "username": "...", "password": "..." }`: signs in on this browser
/// with a session of its own. Answers 401 for a username that doesn't exist and for a wrong
/// password alike, and 429 once a username has had too many wrong ones lately.
pub async fn login(
    State(pool): State<PgPool>,
    State(accounts): State<Accounts>,
    Json(body): Json<Login>,
) -> Result<Json<Signed>, ApiError> {
    // What no account can have is refused without looking, and without counting.
    if !valid_username(&body.username) || !valid_password(&body.password) {
        return Err(ApiError::BadLogin);
    }
    let key = body.username.to_ascii_lowercase();
    if let Some(wait) = accounts.failures().wait(&key, Instant::now()) {
        return Err(ApiError::TooManyAttempts {
            retry_after_secs: wait.as_secs().max(1),
        });
    }

    let account: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, username, password_hash FROM users WHERE lower(username) = $1")
            .bind(&key)
            .fetch_optional(&pool)
            .await
            .map_err(ApiError::database("could not look up a username"))?;
    let stored = account.as_ref().map(|(_, _, hash)| hash.clone());
    let matches = accounts.verify(body.password, stored).await?;
    let Some((user_id, username, _)) = account.filter(|_| matches) else {
        accounts.failures().failed(&key, Instant::now());
        return Err(ApiError::BadLogin);
    };
    accounts.failures().cleared(&key);

    let mut tx = pool
        .begin()
        .await
        .map_err(ApiError::database("could not start signing in"))?;
    sweep_expired_sessions(&mut *tx).await?;
    let access_token = create_session(&mut *tx, user_id).await?;
    tx.commit()
        .await
        .map_err(ApiError::database("could not sign in"))?;
    Ok(Json(Signed {
        user_id,
        access_token,
        username,
    }))
}

/// `POST /api/logout`: ends the session the request was made with, and only that one. Answers
/// 204; for a guest, whose token is not a session, that is all it does.
pub async fn logout(
    AuthSession { session, .. }: AuthSession,
    State(pool): State<PgPool>,
) -> Result<StatusCode, ApiError> {
    if let Some(session) = session {
        end_session(&pool, &session).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub struct DeleteUser {
    /// Needed by an account, and ignored for a guest.
    password: Option<String>,
}

/// `DELETE /api/me` with `{ "password": "..." }`: the user deletes themselves. A guest needs no
/// password. An account that doesn't send one gets 422, and one that sends a wrong one gets 403
/// (not 401, which a client takes to mean its token is no good), counted like a wrong password
/// at sign-in. Answers 204.
///
/// - Games with nobody else in them (bot games, games waiting for an opponent, games whose
///   other players have deleted themselves too) are deleted.
/// - Each other game that is still being played is forfeited, so the opponent wins.
/// - Every other game with another person stays for them, with this player shown as "Deleted
///   player".
/// - The user's sessions and guest token are gone, and so are their username and name. The row
///   itself is removed unless a game that stays refers to it.
///
/// A request that fails halfway can be repeated: forfeiting a game that is over is skipped.
pub async fn delete(
    AuthUser(user_id): AuthUser,
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
    State(accounts): State<Accounts>,
    body: Option<Json<DeleteUser>>,
) -> Result<StatusCode, ApiError> {
    let password = body.and_then(|Json(body)| body.password);
    confirm_password(&pool, &accounts, user_id, password).await?;

    // The games to give up. What to delete is decided again below, in the transaction.
    let games: Vec<(String, bool, bool, bool)> = sqlx::query_as(
        "SELECT g.id, g.finished, g.state IS NOT NULL,
                EXISTS (SELECT 1 FROM game_players o JOIN users u ON u.id = o.user_id
                         WHERE o.game_id = g.id AND o.user_id <> $1 AND NOT u.is_bot
                           AND u.deleted_at IS NULL)
           FROM games g JOIN game_players p ON p.game_id = g.id
          WHERE p.user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .map_err(ApiError::database("could not list a user's games"))?;

    let mut staying = Vec::new();
    for (id, finished, started, others) in games {
        let Ok(id) = id.parse::<GameId>() else {
            continue;
        };
        if !others {
            continue;
        }
        if started && !finished {
            match rooms.forfeit(&id, user_id).await {
                Ok(()) => {}
                // It ended since the list was read, or it is a game that can't be forfeited.
                Err(RoomError::Rejected(reason)) => {
                    tracing::info!(game = %id, reason, "not forfeited for a user who is deleting themselves");
                }
                Err(RoomError::NotFound) => continue,
                Err(err) => {
                    tracing::error!(?err, game = %id, "could not forfeit for a user who is deleting themselves");
                    return Err(ApiError::Internal);
                }
            }
        }
        staying.push(id);
    }

    let deleted_games = remove_user(&pool, user_id).await?;

    // Only now, so that the rooms read the user as deleted.
    rooms.close(&deleted_games);
    rooms.user_gone(user_id);
    for id in &staying {
        if let Err(err) = rooms.user_deleted(id, user_id).await {
            // The game is right in the database; only what its room shows may lag.
            tracing::warn!(?err, game = %id, "could not tell a game its player was deleted");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Checks the password of an account that wants to delete itself. A guest has none.
async fn confirm_password(
    pool: &PgPool,
    accounts: &Accounts,
    user_id: Uuid,
    password: Option<String>,
) -> Result<(), ApiError> {
    let login: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT username, password_hash FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(ApiError::database("could not look up a user"))?;
    let (Some(username), Some(hash)) = login else {
        return Ok(());
    };
    let password = password.ok_or(ApiError::Invalid(
        "enter your password to delete your account",
    ))?;
    let key = username.to_ascii_lowercase();
    if let Some(wait) = accounts.failures().wait(&key, Instant::now()) {
        return Err(ApiError::TooManyAttempts {
            retry_after_secs: wait.as_secs().max(1),
        });
    }
    if !valid_password(&password) || !accounts.verify(password, Some(hash)).await? {
        accounts.failures().failed(&key, Instant::now());
        return Err(ApiError::Forbidden("wrong password"));
    }
    accounts.failures().cleared(&key);
    Ok(())
}

/// Deletes the games the user is alone in, their sessions, and the user, in one transaction. A
/// user that a remaining game refers to is emptied of everything that identified them instead of
/// removed. Returns the games that were deleted.
async fn remove_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<GameId>, ApiError> {
    fn db(err: sqlx::Error) -> ApiError {
        ApiError::database("could not delete a user")(err)
    }
    let mut tx = pool.begin().await.map_err(db)?;

    // `game_history` and `game_players` go with their game.
    let games: Vec<String> = sqlx::query_scalar(
        "DELETE FROM games
          WHERE id IN (SELECT p.game_id FROM game_players p
                        WHERE p.user_id = $1
                          AND NOT EXISTS (SELECT 1 FROM game_players o JOIN users u ON u.id = o.user_id
                                           WHERE o.game_id = p.game_id AND o.user_id <> $1
                                             AND NOT u.is_bot AND u.deleted_at IS NULL))
      RETURNING id",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;

    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let removed = sqlx::query(
        "DELETE FROM users
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM game_players WHERE user_id = $1)",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if removed.rows_affected() == 0 {
        sqlx::query(
            "UPDATE users
                SET username = NULL, password_hash = NULL, access_token = NULL,
                    name = 'Deleted player', deleted_at = now()
              WHERE id = $1",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    // Players who deleted themselves earlier, and whose last game was one of these.
    sqlx::query(
        "DELETE FROM users u
          WHERE u.deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM game_players WHERE user_id = u.id)",
    )
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;

    Ok(games.iter().filter_map(|id| id.parse().ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64, start: Instant) -> Instant {
        start + Duration::from_secs(seconds)
    }

    #[test]
    fn usernames_are_3_to_32_letters_digits_dots_hyphens_and_underscores() {
        for good in ["ada", "Ada_Lovelace", "a.b-c", "x1y", &"a".repeat(32)] {
            assert!(valid_username(good), "{good:?}");
        }
        for bad in [
            "",
            "ab",
            &"a".repeat(33),
            "has space",
            "tab\t",
            "nül",
            "ädä",
            "a@b",
            "a/b",
            " ada",
        ] {
            assert!(!valid_username(bad), "{bad:?}");
        }
    }

    #[test]
    fn passwords_are_8_to_128_characters_and_count_characters_not_bytes() {
        assert!(valid_password("12345678"));
        assert!(valid_password(&"ä".repeat(128)));
        assert!(valid_password("        "), "spaces are allowed, and kept");
        assert!(!valid_password("1234567"));
        assert!(!valid_password(&"ä".repeat(129)));
        assert!(!valid_password(""));
    }

    #[test]
    fn a_username_is_refused_after_five_wrong_passwords_until_the_oldest_expires() {
        let start = Instant::now();
        let mut failures = Failures::default();
        for second in 0..MAX_FAILURES as u64 {
            assert_eq!(failures.wait("ada", at(second, start)), None);
            failures.failed("ada", at(second, start));
        }

        let wait = failures.wait("ada", at(10, start)).expect("refused");
        assert_eq!(wait, FAILURE_WINDOW - Duration::from_secs(10));

        // The first failure (second 0) has expired; the other four haven't.
        assert_eq!(
            failures.wait("ada", at(FAILURE_WINDOW.as_secs(), start)),
            None
        );
    }

    #[test]
    fn failures_are_counted_per_username_and_cleared_by_a_success() {
        let start = Instant::now();
        let mut failures = Failures::default();
        for _ in 0..MAX_FAILURES {
            failures.failed("ada", start);
        }

        assert!(failures.wait("ada", start).is_some());
        assert_eq!(failures.wait("grace", start), None);

        failures.cleared("ada");
        assert_eq!(failures.wait("ada", start), None);
    }

    #[test]
    fn expired_failures_are_dropped_when_there_are_many() {
        let start = Instant::now();
        let mut failures = Failures::default();
        for number in 0..SWEEP_AT {
            failures.failed(&format!("user{number}"), start);
        }

        failures.failed("late", at(FAILURE_WINDOW.as_secs(), start));

        assert_eq!(failures.0.len(), 1);
    }
}

#[cfg(test)]
mod api_tests {
    use axum::http::{Method, StatusCode, header};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::{
        game::Games,
        socket::close,
        test_util::{Client, Reply, Tally, TestApp, bearer},
    };

    const PASSWORD: &str = "correct horse battery";

    fn app(pool: &PgPool) -> TestApp {
        TestApp::new(pool.clone(), Games::default().with::<Tally>())
    }

    async fn me(app: &TestApp, token: &str) -> Reply {
        app.send(Method::GET, "/api/me", Some(&bearer(token)), None)
            .await
    }

    fn token(reply: &Reply) -> &str {
        reply.json["accessToken"].as_str().unwrap()
    }

    /// Makes every session look as if it was last seen `days` days ago.
    async fn backdate_sessions(pool: &PgPool, days: i32) {
        sqlx::query("UPDATE sessions SET last_seen_at = now() - make_interval(days => $1)")
            .bind(days)
            .execute(pool)
            .await
            .unwrap();
    }

    // --- Making an account ---

    #[sqlx::test]
    async fn creating_an_account_returns_a_session_and_retires_the_guest_token(pool: PgPool) {
        let app = app(&pool);
        let (user_id, guest) = app.register_user().await;

        let reply = app.create_account(&guest, "Ada", PASSWORD).await;

        assert_eq!(reply.status, StatusCode::CREATED);
        assert_eq!(reply.json["userId"], user_id.as_str());
        assert_eq!(reply.json["username"], "Ada");
        assert_ne!(token(&reply), guest);
        assert_eq!(me(&app, &guest).await.status, StatusCode::UNAUTHORIZED);
        let signed_in = me(&app, token(&reply)).await;
        assert_eq!(signed_in.status, StatusCode::OK);
        assert_eq!(signed_in.json["userId"], user_id.as_str());
        assert_eq!(signed_in.json["username"], "Ada");
    }

    #[sqlx::test]
    async fn the_games_of_the_guest_are_the_accounts_games(pool: PgPool) {
        let app = app(&pool);
        let (_, guest) = app.register_user().await;
        let game_id = app.create_game(&guest, "tally").await;
        let reply = app.create_account(&guest, "Ada", PASSWORD).await;

        let games = app
            .send(
                Method::GET,
                "/api/games",
                Some(&bearer(token(&reply))),
                None,
            )
            .await;

        assert_eq!(games.status, StatusCode::OK);
        assert_eq!(games.json["games"][0]["gameId"], game_id.as_str());
    }

    #[sqlx::test]
    async fn the_username_becomes_the_name_in_place_of_any_name_the_guest_had(pool: PgPool) {
        let app = app(&pool);
        let (_, nameless) = app.register_user().await;
        let (_, named) = app.register_user().await;
        app.send(
            Method::PATCH,
            "/api/me",
            Some(&bearer(&named)),
            Some(json!({ "name": "Countess" })),
        )
        .await;

        let first = app.create_account(&nameless, "Ada", PASSWORD).await;
        let second = app.create_account(&named, "grace", PASSWORD).await;

        // As the user typed it, whatever its case.
        assert_eq!(me(&app, token(&first)).await.json["name"], "Ada");
        assert_eq!(me(&app, token(&second)).await.json["name"], "grace");
        assert_eq!(me(&app, token(&second)).await.json["username"], "grace");
    }

    #[sqlx::test]
    async fn a_taken_username_is_refused_whatever_its_case_and_leaves_the_guest_alone(
        pool: PgPool,
    ) {
        let app = app(&pool);
        app.register_account("Ada", PASSWORD).await;
        let (_, guest) = app.register_user().await;

        for taken in ["Ada", "ada", "ADA"] {
            let reply = app.create_account(&guest, taken, PASSWORD).await;
            assert_eq!(reply.status, StatusCode::CONFLICT, "{taken}");
        }

        let still_a_guest = me(&app, &guest).await;
        assert_eq!(still_a_guest.status, StatusCode::OK);
        assert_eq!(still_a_guest.json["username"], Value::Null);
    }

    #[sqlx::test]
    async fn an_account_cannot_make_another_account(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;

        let reply = app.create_account(&session, "Grace", PASSWORD).await;

        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(me(&app, &session).await.json["username"], "Ada");
    }

    #[sqlx::test]
    async fn unacceptable_usernames_and_passwords_are_refused_and_change_nothing(pool: PgPool) {
        let app = app(&pool);
        let (_, guest) = app.register_user().await;
        let too_long = "a".repeat(33);

        for (username, password) in [
            ("ab", PASSWORD),
            (too_long.as_str(), PASSWORD),
            ("has space", PASSWORD),
            ("ädä", PASSWORD),
            ("ada", "short"),
            ("ada", ""),
        ] {
            let reply = app.create_account(&guest, username, password).await;
            assert_eq!(
                reply.status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{username:?} {password:?}"
            );
        }

        let still_a_guest = me(&app, &guest).await;
        assert_eq!(still_a_guest.status, StatusCode::OK);
        assert_eq!(still_a_guest.json["username"], Value::Null);
    }

    #[sqlx::test]
    async fn making_an_account_needs_a_known_token(pool: PgPool) {
        let app = app(&pool);
        let body = json!({ "username": "ada", "password": PASSWORD });

        let missing = app
            .send(Method::POST, "/api/account", None, Some(body.clone()))
            .await;
        let unknown = app
            .send(
                Method::POST,
                "/api/account",
                Some("Bearer nope"),
                Some(body),
            )
            .await;

        assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
        assert_eq!(unknown.status, StatusCode::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn the_database_insists_that_an_accounts_name_is_its_username(pool: PgPool) {
        let app = app(&pool);
        let (user_id, _) = app.register_account("Ada", PASSWORD).await;

        for name in ["'Countess'", "NULL", "'ada'"] {
            let changed = match name {
                "'Countess'" => {
                    sqlx::query("UPDATE users SET name = 'Countess' WHERE id = $1::uuid")
                }
                "NULL" => sqlx::query("UPDATE users SET name = NULL WHERE id = $1::uuid"),
                _ => sqlx::query("UPDATE users SET name = 'ada' WHERE id = $1::uuid"),
            }
            .bind(&user_id)
            .execute(&pool)
            .await;
            assert!(changed.is_err(), "{name}");
        }
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM users WHERE id = $1::uuid")
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name.as_deref(), Some("Ada"));
    }

    #[sqlx::test]
    async fn the_database_refuses_an_account_that_still_has_a_guest_token(pool: PgPool) {
        let app = app(&pool);
        let (user_id, _) = app.register_user().await;

        let both = sqlx::query(
            "UPDATE users SET username = 'ada', password_hash = 'x' WHERE id = $1::uuid",
        )
        .bind(&user_id)
        .execute(&pool)
        .await;
        let half = sqlx::query(
            "UPDATE users SET username = 'ada', access_token = NULL WHERE id = $1::uuid",
        )
        .bind(&user_id)
        .execute(&pool)
        .await;

        assert!(both.is_err(), "a password and a guest token at once");
        assert!(half.is_err(), "a username without a password");
    }

    #[sqlx::test]
    async fn the_password_and_the_session_token_are_not_stored(pool: PgPool) {
        let app = app(&pool);
        let (user_id, session) = app.register_account("Ada", PASSWORD).await;

        let hash: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1::uuid")
                .bind(&user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let keys: Vec<Vec<u8>> = sqlx::query_scalar("SELECT token_hash FROM sessions")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert!(hash.starts_with("$argon2id$"), "{hash}");
        assert!(!hash.contains(PASSWORD));
        assert_eq!(keys, vec![Sha256::digest(session.as_bytes()).to_vec()]);
        assert_ne!(keys[0], session.into_bytes());
    }

    // --- Signing in and out ---

    #[sqlx::test]
    async fn signing_in_returns_a_session_for_the_account(pool: PgPool) {
        let app = app(&pool);
        let (user_id, first) = app.register_account("Ada", PASSWORD).await;

        // The name is found whatever its case, and comes back as it was made.
        let reply = app.login("aDa", PASSWORD).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["userId"], user_id.as_str());
        assert_eq!(reply.json["username"], "Ada");
        assert_ne!(token(&reply), first);
        assert_eq!(
            me(&app, token(&reply)).await.json["userId"],
            user_id.as_str()
        );
    }

    #[sqlx::test]
    async fn every_sign_in_is_a_session_of_its_own(pool: PgPool) {
        let app = app(&pool);
        let (_, made_with) = app.register_account("Ada", PASSWORD).await;
        let here = app.login("Ada", PASSWORD).await;
        let there = app.login("Ada", PASSWORD).await;
        assert_ne!(token(&here), token(&there));

        let reply = app
            .send(
                Method::POST,
                "/api/logout",
                Some(&bearer(token(&here))),
                None,
            )
            .await;

        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        assert_eq!(
            me(&app, token(&here)).await.status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(me(&app, token(&there)).await.status, StatusCode::OK);
        assert_eq!(me(&app, &made_with).await.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn a_guest_signing_out_changes_nothing(pool: PgPool) {
        let app = app(&pool);
        let (_, guest) = app.register_user().await;

        let reply = app
            .send(Method::POST, "/api/logout", Some(&bearer(&guest)), None)
            .await;

        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        assert_eq!(me(&app, &guest).await.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn signing_out_needs_a_known_token(pool: PgPool) {
        let app = app(&pool);

        let reply = app.send(Method::POST, "/api/logout", None, None).await;

        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn a_wrong_password_and_an_unknown_username_are_answered_alike(pool: PgPool) {
        let app = app(&pool);
        app.register_account("Ada", PASSWORD).await;

        let wrong = app.login("Ada", "not the password").await;
        let unknown = app.login("Nobody", PASSWORD).await;

        for reply in [&wrong, &unknown] {
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
            // Not a `Bearer` challenge: no token was wrong.
            assert!(!reply.headers.contains_key(header::WWW_AUTHENTICATE));
        }
    }

    #[sqlx::test]
    async fn a_guest_cannot_sign_in_and_neither_can_the_bot(pool: PgPool) {
        let app = app(&pool);
        app.register_user().await;

        for username in ["Bot", "bot", "Guest"] {
            let reply = app.login(username, PASSWORD).await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{username}");
        }
    }

    #[sqlx::test]
    async fn nothing_that_cannot_be_an_accounts_is_even_counted(pool: PgPool) {
        let app = app(&pool);

        for _ in 0..=MAX_FAILURES {
            let reply = app.login("x", "short").await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        }
    }

    #[sqlx::test]
    async fn too_many_wrong_passwords_lock_the_username_for_a_while(pool: PgPool) {
        let app = app(&pool);
        app.register_account("Ada", PASSWORD).await;
        app.register_account("Grace", PASSWORD).await;
        for _ in 0..MAX_FAILURES {
            let reply = app.login("Ada", "not the password").await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        }

        // Even the right password is refused now, whatever the case of the name.
        let locked = app.login("ADA", PASSWORD).await;

        assert_eq!(locked.status, StatusCode::TOO_MANY_REQUESTS);
        let retry: u64 = locked.headers[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((1..=FAILURE_WINDOW.as_secs()).contains(&retry), "{retry}");
        // Others are not.
        assert_eq!(app.login("Grace", PASSWORD).await.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn a_successful_sign_in_forgives_the_wrong_passwords_before_it(pool: PgPool) {
        let app = app(&pool);
        app.register_account("Ada", PASSWORD).await;

        for _ in 0..2 {
            for _ in 0..MAX_FAILURES - 1 {
                let reply = app.login("Ada", "not the password").await;
                assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
            }
            assert_eq!(app.login("Ada", PASSWORD).await.status, StatusCode::OK);
        }
    }

    // --- Expiry ---

    #[sqlx::test]
    async fn a_session_unseen_for_over_30_days_is_refused(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;

        backdate_sessions(&pool, 29).await;
        assert_eq!(me(&app, &session).await.status, StatusCode::OK);

        backdate_sessions(&pool, 31).await;
        assert_eq!(me(&app, &session).await.status, StatusCode::UNAUTHORIZED);
        let other = app
            .send(Method::GET, "/api/games", Some(&bearer(&session)), None)
            .await;
        assert_eq!(other.status, StatusCode::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn reading_the_profile_keeps_a_session_from_expiring(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        backdate_sessions(&pool, 29).await;

        me(&app, &session).await;

        let fresh: bool =
            sqlx::query_scalar("SELECT last_seen_at > now() - interval '1 minute' FROM sessions")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(fresh);
    }

    #[sqlx::test]
    async fn nothing_but_the_profile_refreshes_a_session(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        backdate_sessions(&pool, 29).await;

        app.send(Method::GET, "/api/games", Some(&bearer(&session)), None)
            .await;
        app.create_game(&session, "tally").await;

        let untouched: bool =
            sqlx::query_scalar("SELECT last_seen_at < now() - interval '28 days' FROM sessions")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(untouched);
    }

    #[sqlx::test]
    async fn guests_never_expire(pool: PgPool) {
        let app = app(&pool);
        let (_, guest) = app.register_user().await;
        sqlx::query("UPDATE users SET created_at = now() - interval '400 days'")
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(me(&app, &guest).await.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn signing_in_clears_out_the_sessions_that_have_expired(pool: PgPool) {
        let app = app(&pool);
        let (ada, _) = app.register_account("Ada", PASSWORD).await;
        app.register_account("Grace", PASSWORD).await;
        sqlx::query(
            "UPDATE sessions SET last_seen_at = now() - interval '31 days' WHERE user_id = $1::uuid",
        )
        .bind(&ada)
        .execute(&pool)
        .await
        .unwrap();

        app.login("Grace", PASSWORD).await;

        let left: i64 =
            sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id = $1::uuid")
                .bind(&ada)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(left, 0);
    }

    #[sqlx::test]
    async fn an_expired_session_is_closed_as_unauthorized_on_the_socket(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        let game_id = app.create_game(&session, "tally").await;
        backdate_sessions(&pool, 31).await;
        let server = app.serve().await;

        let mut client = Client::sign_in(&server, &game_id, &session).await;

        assert_eq!(client.closed().await, close::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn a_session_works_on_the_socket(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        let game_id = app.create_game(&session, "tally").await;
        let server = app.serve().await;

        let mut client = Client::sign_in(&server, &game_id, &session).await;

        assert_eq!(client.next().await["type"], "snapshot");
    }
}

#[cfg(test)]
mod delete_tests {
    use axum::http::{Method, StatusCode};
    use serde_json::{Value, json};

    use super::*;
    use crate::{
        game::Games,
        long_backgammon::LongBackgammon,
        socket::close,
        test_util::{Client, Quick, Reply, Tally, TestApp, bearer},
    };

    const PASSWORD: &str = "correct horse battery";
    const GAME: &str = "long-backgammon";

    fn app(pool: &PgPool) -> TestApp {
        TestApp::new(
            pool.clone(),
            Games::default()
                .with::<LongBackgammon>()
                .with::<Tally>()
                .with::<Quick>(),
        )
    }

    async fn delete_me(app: &TestApp, token: &str, password: Option<&str>) -> Reply {
        let body = password.map(|password| json!({ "password": password }));
        app.send(Method::DELETE, "/api/me", Some(&bearer(token)), body)
            .await
    }

    async fn is_known(app: &TestApp, token: &str) -> bool {
        let reply = app
            .send(Method::GET, "/api/me", Some(&bearer(token)), None)
            .await;
        reply.status == StatusCode::OK
    }

    async fn count(pool: &PgPool, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
    }

    /// A started game of backgammon between the account and a new guest, the account in seat
    /// 0. Returns the game id and the guest's token.
    async fn game_with_a_guest(app: &TestApp, account: &str) -> (String, String) {
        let (_, guest) = app.register_user().await;
        let game_id = app.create_game(account, GAME).await;
        app.join_game(&guest, &game_id).await;
        (game_id, guest)
    }

    #[sqlx::test]
    async fn a_guest_can_delete_themselves_without_a_password(pool: PgPool) {
        let app = app(&pool);
        let (_, guest) = app.register_user().await;

        let with_none = delete_me(&app, &guest, None).await;

        assert_eq!(with_none.status, StatusCode::NO_CONTENT);
        assert!(!is_known(&app, &guest).await);
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM users WHERE access_token IS NOT NULL"
            )
            .await,
            0
        );
    }

    #[sqlx::test]
    async fn an_account_needs_its_password_to_delete_itself(pool: PgPool) {
        let app = app(&pool);
        let (user_id, session) = app.register_account("Ada", PASSWORD).await;

        let missing = delete_me(&app, &session, None).await;
        let wrong = delete_me(&app, &session, Some("not the password")).await;

        assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
        // Not 401: a client takes that to mean its token is no good.
        assert_eq!(wrong.status, StatusCode::FORBIDDEN);
        assert!(is_known(&app, &session).await);
        assert!(!user_id.is_empty());
    }

    #[sqlx::test]
    async fn deleting_an_account_removes_it_and_every_session_it_had(pool: PgPool) {
        let app = app(&pool);
        let (_, made_with) = app.register_account("Ada", PASSWORD).await;
        let other = app.login("Ada", PASSWORD).await;
        let other = other.json["accessToken"].as_str().unwrap().to_owned();

        let reply = delete_me(&app, &made_with, Some(PASSWORD)).await;

        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        assert!(!is_known(&app, &made_with).await);
        assert!(!is_known(&app, &other).await);
        assert_eq!(
            app.login("Ada", PASSWORD).await.status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(count(&pool, "SELECT count(*) FROM sessions").await, 0);
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM users WHERE username IS NOT NULL"
            )
            .await,
            0
        );
    }

    #[sqlx::test]
    async fn a_deleted_username_can_be_taken_again(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        delete_me(&app, &session, Some(PASSWORD)).await;

        let (_, again) = app.register_account("Ada", "another password").await;

        assert!(is_known(&app, &again).await);
    }

    #[sqlx::test]
    async fn wrong_passwords_when_deleting_count_like_wrong_passwords_when_signing_in(
        pool: PgPool,
    ) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        for _ in 0..MAX_FAILURES {
            let reply = delete_me(&app, &session, Some("not the password")).await;
            assert_eq!(reply.status, StatusCode::FORBIDDEN);
        }

        let reply = delete_me(&app, &session, Some(PASSWORD)).await;

        assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(is_known(&app, &session).await);
    }

    #[sqlx::test]
    async fn bot_games_and_games_waiting_for_an_opponent_are_deleted(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        app.create_game(&session, GAME).await;
        let bot = app.create_bot_game(&session, GAME).await;
        assert_eq!(bot.status, StatusCode::CREATED);
        // Whichever level the bot is.
        for level in ["easy", "hard"] {
            let bot = app.create_bot_game_at(&session, GAME, level).await;
            assert_eq!(bot.status, StatusCode::CREATED);
        }

        delete_me(&app, &session, Some(PASSWORD)).await;

        assert_eq!(count(&pool, "SELECT count(*) FROM games").await, 0);
        assert_eq!(count(&pool, "SELECT count(*) FROM game_players").await, 0);
        assert_eq!(count(&pool, "SELECT count(*) FROM game_history").await, 0);
        // The bot is a user too, and stays.
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM users WHERE deleted_at IS NOT NULL"
            )
            .await,
            0
        );
    }

    #[sqlx::test]
    async fn a_game_being_played_against_a_person_is_forfeited_and_stays_for_them(pool: PgPool) {
        let app = app(&pool);
        let (ada, session) = app.register_account("Ada", PASSWORD).await;
        let (game_id, guest) = game_with_a_guest(&app, &session).await;

        delete_me(&app, &session, Some(PASSWORD)).await;

        let server = app.serve().await;
        let mut grace = Client::sign_in(&server, &game_id, &guest).await;
        let snapshot = grace.next().await;
        // Ada had seat 0, so the guest in seat 1 won, 1 point, by forfeit.
        assert_eq!(
            snapshot["state"]["phase"],
            json!({ "type": "over", "winner": 1, "points": 1, "forfeited": true })
        );
        assert_eq!(snapshot["players"][0], ada.as_str());
        assert_eq!(snapshot["playerNames"][0], "Deleted player");
        let emptied: bool = sqlx::query_scalar(
            "SELECT username IS NULL AND password_hash IS NULL AND access_token IS NULL
                AND name = 'Deleted player' AND deleted_at IS NOT NULL
               FROM users WHERE id = $1::uuid",
        )
        .bind(&ada)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(emptied);
        assert_eq!(
            count(&pool, "SELECT count(*) FROM games WHERE finished").await,
            1
        );
    }

    #[sqlx::test]
    async fn the_opponent_watching_sees_the_forfeit_as_it_happens(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        let (game_id, guest) = game_with_a_guest(&app, &session).await;
        let server = app.serve().await;
        let mut grace = Client::sign_in(&server, &game_id, &guest).await;
        grace.next().await;

        delete_me(&app, &session, Some(PASSWORD)).await;

        let mut snapshot = grace.next().await;
        // The forfeit, and then the name that shows that Ada is gone: the same result twice.
        for _ in 0..3 {
            if snapshot["playerNames"][0] == "Deleted player" {
                break;
            }
            snapshot = grace.next().await;
        }
        assert_eq!(snapshot["state"]["phase"]["forfeited"], true);
        assert_eq!(snapshot["playerNames"][0], "Deleted player");
    }

    #[sqlx::test]
    async fn a_finished_game_against_a_person_stays_as_it_was(pool: PgPool) {
        let app = app(&pool);
        let (game_id, [(first, first_token), (_, second_token)]) = app.finished_quick_game().await;

        let reply = delete_me(&app, &first_token, None).await;

        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        let server = app.serve().await;
        let mut other = Client::sign_in(&server, &game_id, &second_token).await;
        let snapshot = other.next().await;
        assert_eq!(snapshot["state"], json!({ "over": true }));
        assert_eq!(snapshot["players"][0], first.as_str());
        assert_eq!(snapshot["playerNames"][0], "Deleted player");
    }

    #[sqlx::test]
    async fn a_game_is_deleted_with_the_last_of_its_players(pool: PgPool) {
        let app = app(&pool);
        let (game_id, [(_, first), (_, second)]) = app.finished_quick_game().await;

        delete_me(&app, &first, None).await;
        assert_eq!(count(&pool, "SELECT count(*) FROM games").await, 1);
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM users WHERE deleted_at IS NOT NULL"
            )
            .await,
            1
        );

        delete_me(&app, &second, None).await;

        assert_eq!(
            count(&pool, "SELECT count(*) FROM games").await,
            0,
            "{game_id}"
        );
        // Nothing is left of either, not even the empty row the first one left behind.
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM users WHERE access_token IS NOT NULL"
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM users WHERE deleted_at IS NOT NULL"
            )
            .await,
            0
        );
    }

    #[sqlx::test]
    async fn a_rematch_waiting_for_a_deleted_player_is_dropped_and_cannot_be_answered(
        pool: PgPool,
    ) {
        let app = app(&pool);
        let (game_id, [(_, first), (_, second)]) = app.finished_quick_game().await;
        let asked = app.ask_rematch(&first, &game_id).await;
        assert_eq!(asked.json["rematch"]["type"], "offered");

        delete_me(&app, &first, None).await;

        let server = app.serve().await;
        let mut other = Client::sign_in(&server, &game_id, &second).await;
        assert_eq!(other.next().await["rematch"], Value::Null);
        let answer = app.ask_rematch(&second, &game_id).await;
        assert_eq!(answer.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            count(&pool, "SELECT count(*) FROM games").await,
            1,
            "no rematch was made"
        );
    }

    #[sqlx::test]
    async fn a_deleted_users_open_sockets_are_closed(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        // Ada watches a game of other people's.
        let (_, first) = app.register_user().await;
        let (_, second) = app.register_user().await;
        let game_id = app.create_game(&first, "tally").await;
        app.join_game(&second, &game_id).await;
        let server = app.serve().await;
        let mut watching = Client::sign_in(&server, &game_id, &session).await;
        watching.next().await;

        delete_me(&app, &session, Some(PASSWORD)).await;

        assert_eq!(watching.closed().await, close::RESTART);
        // And she can't come back in.
        let mut again = Client::sign_in(&server, &game_id, &session).await;
        assert_eq!(again.closed().await, close::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn the_watchers_of_a_deleted_game_are_sent_away(pool: PgPool) {
        let app = app(&pool);
        let (_, session) = app.register_account("Ada", PASSWORD).await;
        let game_id = app.create_game(&session, GAME).await;
        let (_, watcher) = app.register_user().await;
        let server = app.serve().await;
        let mut watching = Client::sign_in(&server, &game_id, &watcher).await;
        watching.next().await;

        delete_me(&app, &session, Some(PASSWORD)).await;

        assert_eq!(watching.closed().await, close::RESTART);
        let mut again = Client::sign_in(&server, &game_id, &watcher).await;
        assert_eq!(again.closed().await, close::NOT_FOUND);
    }
}
