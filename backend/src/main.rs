use std::{env, error::Error, time::Duration};

use axum::{
    Router,
    extract::{FromRef, State},
    http::StatusCode,
    routing::{get, post},
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{net::TcpListener, signal};
use tracing_subscriber::EnvFilter;

use crate::{account::Accounts, game::Games, preview::Pages, room::Rooms};

mod account;
mod auth;
mod bot;
mod delta;
mod error;
mod game;
mod game_id;
mod hex;
mod history;
mod lobby;
mod long_backgammon;
mod preview;
mod profile;
mod rematch;
mod room;
mod socket;
#[cfg(test)]
mod test_util;
mod ultimate_tic_tac_toe;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let database_url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;
    let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await
        .map_err(|err| format!("could not connect to the database: {err}"))?;
    tracing::info!("connected to database");

    // The migrations in `backend/migrations` are embedded in the binary at compile time.
    sqlx::migrate!()
        .run(&pool)
        .await
        .map_err(|err| format!("could not run database migrations: {err}"))?;

    let pages = pages_from_env()?;

    let listener = TcpListener::bind(&bind_addr).await?;
    tracing::info!("listening on {}", listener.local_addr()?);

    axum::serve(
        listener,
        app(AppState::new(pool, game::registry()).with_pages(pages)),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// The page the server serves for a game, so that a link to it unfolds into a preview (see
/// `preview`). It needs the front end's built `index.html` (`FRONTEND_INDEX`) and the address
/// of the site (`PUBLIC_URL`, e.g. `https://games.example`), and has neither when a developer
/// runs the server beside Vite, which serves the site itself. Only one of them is a mistake.
fn pages_from_env() -> Result<Pages, String> {
    match (env::var("FRONTEND_INDEX"), env::var("PUBLIC_URL")) {
        (Ok(index), Ok(url)) => {
            let pages =
                Pages::new(index.into(), &url).map_err(|err| format!("FRONTEND_INDEX: {err}"))?;
            tracing::info!("serving game pages with previews, for {url}");
            Ok(pages)
        }
        (Err(_), Err(_)) => {
            tracing::info!("FRONTEND_INDEX and PUBLIC_URL are not set: not serving game pages");
            Ok(Pages::default())
        }
        _ => Err("FRONTEND_INDEX and PUBLIC_URL must be set together".to_owned()),
    }
}

/// What handlers share. They take the parts they need with `State<PgPool>`, `State<Rooms>`,
/// `State<Accounts>` or `State<Pages>`.
#[derive(Clone)]
struct AppState {
    pool: PgPool,
    rooms: Rooms,
    accounts: Accounts,
    pages: Pages,
}

impl AppState {
    fn new(pool: PgPool, games: Games) -> Self {
        Self {
            rooms: Rooms::new(pool.clone(), games),
            accounts: Accounts::new(),
            pages: Pages::default(),
            pool,
        }
    }

    fn with_pages(self, pages: Pages) -> Self {
        Self { pages, ..self }
    }
}

impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

impl FromRef<AppState> for Rooms {
    fn from_ref(state: &AppState) -> Self {
        state.rooms.clone()
    }
}

impl FromRef<AppState> for Accounts {
    fn from_ref(state: &AppState) -> Self {
        state.accounts.clone()
    }
}

impl FromRef<AppState> for Pages {
    fn from_ref(state: &AppState) -> Self {
        state.pages.clone()
    }
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/register", post(auth::register))
        .route("/api/account", post(account::create))
        .route("/api/login", post(account::login))
        .route("/api/logout", post(account::logout))
        .route(
            "/api/me",
            get(profile::me)
                .patch(profile::set_name)
                .delete(account::delete),
        )
        .route(
            "/api/games",
            get(lobby::list_games).post(lobby::create_game),
        )
        .route("/api/public-games", get(lobby::list_public_games))
        .route("/api/games/{id}/join", post(lobby::join_game))
        .route(
            "/api/games/{id}/rematch",
            post(lobby::ask_rematch).delete(lobby::decline_rematch),
        )
        .route("/api/games/{id}/history", get(history::game_history))
        .route("/api/games/{id}/preview.png", get(preview::picture))
        .route("/api/games/{id}/ws", get(socket::connect))
        // Not an API: the address of a game's page, which Caddy hands over (see `preview`).
        .route("/games/{*path}", get(preview::page))
        .with_state(state)
}

/// Returns 200 if the database answers a trivial query, 503 otherwise.
async fn health(State(pool): State<PgPool>) -> StatusCode {
    match sqlx::query("SELECT 1").execute(&pool).await {
        Ok(_) => StatusCode::OK,
        Err(err) => {
            tracing::error!(%err, "health check failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

/// Resolves on Ctrl+C or SIGTERM. Without the SIGTERM handler, `docker stop` waits
/// out its timeout and SIGKILLs the server, because PID 1 ignores signals it doesn't handle.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::*;

    async fn health_status(pool: PgPool) -> StatusCode {
        let request = Request::get("/api/health").body(Body::empty()).unwrap();
        app(AppState::new(pool, Games::default()))
            .oneshot(request)
            .await
            .unwrap()
            .status()
    }

    // `#[sqlx::test]` creates a fresh database per test from `DATABASE_URL`.
    #[sqlx::test]
    async fn health_is_ok_when_database_is_reachable(pool: PgPool) {
        assert_eq!(health_status(pool).await, StatusCode::OK);
    }

    // A lazy pool never connects, so this runs without a database.
    #[tokio::test]
    async fn health_is_unavailable_when_pool_is_closed() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        pool.close().await;
        assert_eq!(health_status(pool).await, StatusCode::SERVICE_UNAVAILABLE);
    }
}
