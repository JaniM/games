//! What a link to a game shows when it is pasted where links are unfolded, such as a chat: the
//! game's name, who plays it, and a picture of the board as it stands.
//!
//! The programs that unfold links read the page's HTML and don't run its scripts, so the site's
//! single page, which is only a shell until its script has drawn it, tells them nothing. For
//! the address of a game ([`page`]) the server sends that shell with
//! [Open Graph](https://ogp.me) tags added to its head: the name of the game as the title, the
//! players as the description, and the address of the picture. [`picture`] is the picture, a PNG
//! drawn from the game's state (see [`Game::picture`](crate::game::Game::picture)).
//!
//! The game's id is its access control (see `lobby`), and the link is the id, so what the link
//! shows is what anyone who has it can see by opening it: both routes need no token. They only
//! read. In particular, unfolding an invite doesn't take the seat it offers.
//!
//! The page has to open whatever happens here. A game that can't be found, or a state that can't
//! be read, gives the shell as it is, and the site tells the visitor what is wrong with the link.

use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use resvg::{tiny_skia, usvg};
use serde_json::Value;
use sqlx::PgPool;
use tokio::sync::Semaphore;

use crate::{
    error::ApiError,
    game::{Engine, Games, StateError},
    game_id::GameId,
    room::Rooms,
};

/// The size of the picture. 1.91 to 1 is what the cards of the programs that unfold links are
/// cut to, and 1200 wide is as sharp as any of them asks for.
const CARD_WIDTH: u32 = 1200;
const CARD_HEIGHT: u32 = 630;
/// The space round the board.
const CARD_MARGIN: f32 = 24.0;
/// The background of the page in its dark colours (`--bg` in `styles/tokens.css`), which the
/// games' pictures are drawn in.
const CARD_BACKGROUND: (u8, u8, u8) = (0x16, 0x14, 0x0f);

/// How long what a program that unfolds links fetched may be kept. The address of a picture has
/// the game's revision in it (see [`page`]), so a game that has moved on is a new address.
const PICTURE_CACHE: &str = "public, max-age=300";

/// How many pictures may be drawn at once. Each is a pixmap of 3 MB and a PNG made from it.
const MAX_RENDERS: usize = 4;
static RENDERING: Semaphore = Semaphore::const_new(MAX_RENDERS);

/// Where the built page of the site is and where the site is: what [`page`] needs to answer. A
/// server that isn't given them (the one a developer runs, where Vite serves the site) doesn't
/// serve game pages, and the pictures work without them.
#[derive(Clone, Default)]
pub struct Pages(Option<Arc<Site>>);

struct Site {
    /// The front end's `index.html`, as its build made it. It is read for every page that is
    /// served, not once: its file names change with every build, and a copy from before a deploy
    /// would name files the site no longer has. It is a small file, in the system's cache.
    index: PathBuf,
    /// The address of the site with no slash at the end, e.g. `https://games.example`. The tags
    /// need whole addresses, because they are read somewhere else.
    url: String,
}

/// Where the tags go in the front end's page.
const HEAD_END: &str = "</head>";

impl Pages {
    /// `index` is where the front end's `index.html` is, and `url` is where the site is. The
    /// error is for the person who starts the server: a page that can't be read, or has no head
    /// to put the tags in, is found now and not by the first visitor.
    pub fn new(index: PathBuf, url: &str) -> Result<Self, String> {
        let shell = std::fs::read_to_string(&index)
            .map_err(|err| format!("could not read {}: {err}", index.display()))?;
        if !shell.contains(HEAD_END) {
            return Err(format!("{} has no {HEAD_END}", index.display()));
        }
        Ok(Self(Some(Arc::new(Site {
            index,
            url: url.trim_end_matches('/').to_owned(),
        }))))
    }
}

/// A game as its preview shows it.
struct Found {
    kind: String,
    state_version: i32,
    /// Null until the game starts.
    state: Option<Value>,
    revision: i64,
    /// The names of the players who have joined, as the game's page shows them, by seat.
    names: Vec<String>,
}

type FoundRow = (
    String,
    i32,
    Option<Value>,
    i64,
    Vec<Option<String>>,
    Vec<bool>,
);

/// Reads a game from the database, which has every state a client has seen: a room saves a change
/// before it tells anyone. `None` if there is no such game.
async fn find(pool: &PgPool, id: &GameId) -> Result<Option<Found>, sqlx::Error> {
    let row: Option<FoundRow> = sqlx::query_as(
        "SELECT g.kind,
                g.state_version,
                g.state,
                g.revision,
                ARRAY(SELECT u.name
                      FROM game_players gp
                      JOIN users u ON u.id = gp.user_id
                      WHERE gp.game_id = g.id
                      ORDER BY gp.seat),
                -- A guest here is one in a room (`read_players` in `room`): keep the two the same.
                ARRAY(SELECT u.username IS NULL AND u.deleted_at IS NULL AND NOT u.is_bot
                      FROM game_players gp
                      JOIN users u ON u.id = gp.user_id
                      WHERE gp.game_id = g.id
                      ORDER BY gp.seat)
         FROM games g
         WHERE g.id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(kind, state_version, state, revision, names, guests)| Found {
            kind,
            state_version,
            state,
            revision,
            names: names
                .iter()
                .enumerate()
                .map(|(seat, name)| player_name(name.as_deref(), guests[seat], seat))
                .collect(),
        },
    ))
}

/// A player's name as the others see it: `playerName` in `frontend/src/playerName.ts`, which has
/// the reasons. An account's name is its username, a guest's is marked, and one with no name is
/// "Player 2".
fn player_name(name: Option<&str>, guest: bool, seat: usize) -> String {
    match name {
        None => format!("Player {}", seat + 1),
        Some(name) if guest => format!("{name} (guest)"),
        Some(name) => name.to_owned(),
    }
}

impl Found {
    /// What the picture is of, as SVG: the game as it stands, or at the start if nobody has
    /// begun. `None` for a game that has no picture.
    fn board(&self, engine: &dyn Engine) -> Result<Option<String>, StateError> {
        let Some(state) = &self.state else {
            return Ok(engine.unstarted_picture());
        };
        let version = u32::try_from(self.state_version)
            .map_err(|_| StateError::new("a state version below 0"))?;
        Ok(engine.load(version, state.clone())?.picture())
    }

    /// Who plays, in a few words: both names, or whose game waits for an opponent.
    fn players(&self, engine: &dyn Engine) -> String {
        match self.names.as_slice() {
            [first] if engine.players() > 1 => format!("{first} is waiting for an opponent"),
            names => names.join(" vs "),
        }
    }
}

/// `GET /api/games/{id}/preview.png`: a picture of the game's board as it stands, 1200 by 630,
/// as a PNG. **Needs no token**, as the page of the game doesn't: see the notes at the top.
/// Answers 404 for an unknown game and for a game that has no picture.
///
/// A game that hasn't started is shown at the start. The picture is always of the game as it is
/// when it is asked for. `?rev=` is ignored: the page puts the game's revision in the address so
/// that a program that keeps pictures by address fetches a new one when the game has moved.
pub async fn picture(
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
    Path(game_id): Path<GameId>,
) -> Result<Response, ApiError> {
    let found = find(&pool, &game_id)
        .await
        .map_err(ApiError::database(
            "could not look up a game for its picture",
        ))?
        .ok_or(ApiError::NotFound)?;
    let Some(engine) = rooms.games().get(&found.kind) else {
        tracing::error!(game = %game_id, kind = found.kind, "stored game of unknown kind");
        return Err(ApiError::Internal);
    };
    let board = found
        .board(engine.as_ref())
        .map_err(|err| {
            tracing::error!(%err, game = %game_id, "could not draw a game");
            ApiError::Internal
        })?
        .ok_or(ApiError::NotFound)?;
    // Drawing takes some milliseconds of the processor and a few megabytes, which a task on the
    // runtime's threads must not hold on to, and which a burst of requests must not multiply. The
    // place is given back when the drawing is done, even if the request was dropped.
    let place = RENDERING.acquire().await.map_err(|err| {
        tracing::error!(%err, "the drawing limit was closed");
        ApiError::Internal
    })?;
    let png = tokio::task::spawn_blocking(move || {
        let _place = place;
        render(&board)
    })
    .await
    .map_err(|err| {
        tracing::error!(%err, game = %game_id, "drawing a game panicked");
        ApiError::Internal
    })?
    .map_err(|err| {
        tracing::error!(%err, game = %game_id, "could not draw a game");
        ApiError::Internal
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, PICTURE_CACHE),
        ],
        png,
    )
        .into_response())
}

/// Draws a board, an SVG document, as the picture: centred on the page's dark background, as large
/// as fits inside the margin. The error is for the log: a game's SVG that can't be drawn is a bug.
fn render(board: &str) -> Result<Vec<u8>, String> {
    let tree = usvg::Tree::from_str(board, &usvg::Options::default())
        .map_err(|err| format!("the board is not an SVG: {err}"))?;
    let mut card = tiny_skia::Pixmap::new(CARD_WIDTH, CARD_HEIGHT).ok_or("the card has no size")?;
    let (red, green, blue) = CARD_BACKGROUND;
    card.fill(tiny_skia::Color::from_rgba8(red, green, blue, 0xff));

    let size = tree.size();
    let scale = ((CARD_WIDTH as f32 - 2.0 * CARD_MARGIN) / size.width())
        .min((CARD_HEIGHT as f32 - 2.0 * CARD_MARGIN) / size.height());
    let place = tiny_skia::Transform::from_translate(
        (CARD_WIDTH as f32 - size.width() * scale) / 2.0,
        (CARD_HEIGHT as f32 - size.height() * scale) / 2.0,
    )
    .pre_scale(scale, scale);
    resvg::render(&tree, place, &mut card.as_mut());
    card.encode_png()
        .map_err(|err| format!("could not write the picture as a PNG: {err}"))
}

/// `GET /games/{path}`: the page of the site for a game, with tags that tell programs that unfold
/// links what the game is. `path` is what follows `/games/`: an id, or the kind of game and an id,
/// which is how links used to be written.
///
/// The server doesn't serve this unless it was given the page (see [`Pages`]), and then
/// answers 404. Anything that isn't the address of a game that exists gets the page as it is.
/// Answers 500 if the page can't be read, which is a fault of the deployment. **Needs no token.**
pub async fn page(
    State(pages): State<Pages>,
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
    Path(path): Path<String>,
) -> Response {
    let Some(site) = pages.0 else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let shell = match tokio::fs::read_to_string(&site.index).await {
        Ok(shell) => shell,
        Err(err) => {
            tracing::error!(%err, index = %site.index.display(), "could not read the page of the site");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let tags = match game_in(&path, rooms.games()) {
        Some(id) => tags_for(&site, &pool, &rooms, &id).await,
        None => None,
    };
    let html = match tags {
        Some(tags) => shell.replacen(HEAD_END, &format!("{tags}{HEAD_END}"), 1),
        None => shell,
    };
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // As the shell is served otherwise: a game changes, and so does the build.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}

/// The id a path under `/games/` names, in the two shapes the front end reads (see its
/// `parseRoute`): `<id>`, or `<kind>/<id>` of a game the server offers, and a slash at the end is
/// ignored. An id is in lower case, which is how a pasted upper-case one is the same game.
fn game_in(path: &str, games: &Games) -> Option<GameId> {
    let path = path.strip_suffix('/').unwrap_or(path);
    let id = match path.split('/').collect::<Vec<_>>()[..] {
        [id] => id,
        [kind, id] if games.get(kind).is_some() => id,
        _ => return None,
    };
    id.to_ascii_lowercase().parse().ok()
}

/// The tags for the game with this id, or none if there is nothing to say: it doesn't exist, or
/// can't be read, which is logged.
async fn tags_for(site: &Site, pool: &PgPool, rooms: &Rooms, id: &GameId) -> Option<String> {
    let found = match find(pool, id).await {
        Ok(found) => found?,
        Err(err) => {
            tracing::error!(%err, game = %id, "could not look up a game for its page");
            return None;
        }
    };
    let Some(engine) = rooms.games().get(&found.kind) else {
        tracing::error!(game = %id, kind = found.kind, "stored game of unknown kind");
        return None;
    };
    // Whether there is a picture is asked of the game now, so that the tags don't promise one the
    // address then can't give. It is drawn when the address is fetched.
    let has_picture = match found.board(engine.as_ref()) {
        Ok(board) => board.is_some(),
        Err(err) => {
            tracing::error!(%err, game = %id, "could not draw a game for its page");
            return None;
        }
    };
    let title = engine.name();
    let description = found.players(engine.as_ref());
    let page = format!("{}/games/{id}", site.url);
    let mut tags = vec![
        ("property", "og:type", "website".to_owned()),
        ("property", "og:site_name", "Games".to_owned()),
        ("property", "og:title", title.to_owned()),
        ("property", "og:description", description.clone()),
        ("property", "og:url", page),
    ];
    if has_picture {
        tags.extend([
            (
                "property",
                "og:image",
                format!(
                    "{}/api/games/{id}/preview.png?rev={}",
                    site.url, found.revision
                ),
            ),
            ("property", "og:image:type", "image/png".to_owned()),
            ("property", "og:image:width", CARD_WIDTH.to_string()),
            ("property", "og:image:height", CARD_HEIGHT.to_string()),
            (
                "property",
                "og:image:alt",
                format!("{title}: {description}"),
            ),
        ]);
    }
    let card = if has_picture {
        "summary_large_image"
    } else {
        "summary"
    };
    tags.push(("name", "twitter:card", card.to_owned()));
    Some(
        tags.into_iter()
            .map(|(attribute, key, value)| {
                format!(
                    "<meta {attribute}=\"{key}\" content=\"{}\">\n",
                    escape(&value)
                )
            })
            .collect(),
    )
}

/// `text` as the value of an HTML attribute in double quotes. Players' names go in the tags, and
/// they are anything a person typed.
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            c => escaped.push(c),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use axum::http::Method;
    use serde_json::json;

    use super::*;
    use crate::{
        game::registry,
        test_util::{Reply, Tally, TestApp, bearer},
    };

    const SHELL: &str = "<!doctype html><html><head><title>Games</title></head><body><div id=\"root\"></div></body></html>";

    /// A file of its own with `contents`, as the front end's build leaves its page. Every call
    /// makes a new one: the tests run side by side, and a file that is written again is, for a
    /// moment, empty to whoever reads it.
    fn page_file(contents: &str) -> PathBuf {
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("games-backend-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!(
            "index-{}.html",
            COUNT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::write(&path, contents).unwrap();
        path
    }

    /// An app that serves the pages of games, as the site is deployed, with the real games.
    fn app(pool: PgPool) -> TestApp {
        app_with_page(pool, &page_file(SHELL))
    }

    fn app_with_page(pool: PgPool, page: &Path) -> TestApp {
        TestApp::with_pages(
            pool,
            registry().with::<Tally>(),
            Pages::new(page.to_owned(), "https://games.example/").unwrap(),
        )
    }

    async fn get(app: &TestApp, uri: &str) -> Reply {
        app.send(Method::GET, uri, None, None).await
    }

    /// A reply's body as text.
    fn text(reply: &Reply) -> &str {
        std::str::from_utf8(&reply.body).expect("the body is text")
    }

    /// The `content` of the tag whose `property` or `name` is `key`, undone from its escapes.
    fn tag(html: &str, key: &str) -> Option<String> {
        let opening = format!("=\"{key}\" content=\"");
        let start = html.find(&opening)? + opening.len();
        let end = html[start..].find("\">")? + start;
        Some(
            html[start..end]
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&amp;", "&"),
        )
    }

    async fn rename(app: &TestApp, token: &str, name: &str) {
        let reply = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(token)),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.json);
    }

    /// A started game of `kind` between the account `ada` and a guest called `guest_name`. An
    /// app has one account of that name, so a test that makes two games has its own `ada`s.
    async fn started(app: &TestApp, kind: &str, guest_name: &str) -> String {
        started_by(app, "ada", kind, guest_name).await
    }

    async fn started_by(app: &TestApp, account: &str, kind: &str, guest_name: &str) -> String {
        let (_, ada) = app.register_account(account, "correct horse battery").await;
        let (_, guest) = app.register_user().await;
        rename(app, &guest, guest_name).await;
        let game = app.create_game(&ada, kind).await;
        app.join_game(&guest, &game).await;
        game
    }

    fn png_size(png: &[u8]) -> (u32, u32) {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
        let be = |at: usize| u32::from_be_bytes(png[at..at + 4].try_into().unwrap());
        (be(16), be(20))
    }

    #[sqlx::test]
    async fn the_page_of_a_started_game_names_the_game_the_players_and_the_picture(pool: PgPool) {
        let app = app(pool);
        let game = started(&app, "ultimate-tic-tac-toe", "Grace").await;

        let reply = get(&app, &format!("/games/{game}")).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            reply.headers[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-cache");
        let html = text(&reply);
        assert_eq!(
            tag(html, "og:title").as_deref(),
            Some("Ultimate tic-tac-toe")
        );
        // The account as it is, the guest marked as a guest.
        assert_eq!(
            tag(html, "og:description").as_deref(),
            Some("ada vs Grace (guest)")
        );
        assert_eq!(
            tag(html, "og:url").as_deref(),
            Some(format!("https://games.example/games/{game}").as_str())
        );
        let image = tag(html, "og:image").unwrap();
        assert!(
            image.starts_with(&format!(
                "https://games.example/api/games/{game}/preview.png?rev="
            )),
            "{image}"
        );
        assert_eq!(tag(html, "og:image:width").as_deref(), Some("1200"));
        assert_eq!(tag(html, "og:image:height").as_deref(), Some("630"));
        assert_eq!(
            tag(html, "twitter:card").as_deref(),
            Some("summary_large_image")
        );
        // The shell is all there, with the tags in its head.
        assert!(html.contains("<div id=\"root\"></div>"));
        assert!(html.find("og:title").unwrap() < html.find("</head>").unwrap());
    }

    #[sqlx::test]
    async fn the_revision_in_the_picture_address_follows_the_game(pool: PgPool) {
        let app = app(pool.clone());
        let game = started(&app, "ultimate-tic-tac-toe", "Grace").await;
        let address = |reply: &Reply| tag(text(reply), "og:image").unwrap();
        let before = address(&get(&app, &format!("/games/{game}")).await);

        sqlx::query("UPDATE games SET revision = revision + 1 WHERE id = $1")
            .bind(&game)
            .execute(&pool)
            .await
            .unwrap();
        let after = address(&get(&app, &format!("/games/{game}")).await);

        assert_ne!(before, after);
    }

    #[sqlx::test]
    async fn a_game_waiting_for_an_opponent_says_whose_it_is_and_shows_the_start(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_account("ada", "correct horse battery").await;
        let game = app.create_game(&ada, "long-backgammon").await;

        let reply = get(&app, &format!("/games/{game}")).await;

        let html = text(&reply);
        assert_eq!(tag(html, "og:title").as_deref(), Some("Long backgammon"));
        assert_eq!(
            tag(html, "og:description").as_deref(),
            Some("ada is waiting for an opponent")
        );
        assert!(tag(html, "og:image").is_some());
    }

    #[sqlx::test]
    async fn a_player_with_no_name_is_player_n_and_the_bot_is_the_bot(pool: PgPool) {
        let app = app(pool);
        let (_, nameless) = app.register_user().await;
        let game = app.create_game(&nameless, "ultimate-tic-tac-toe").await;
        let against_bot = app
            .create_bot_game(&nameless, "ultimate-tic-tac-toe")
            .await
            .json["gameId"]
            .as_str()
            .unwrap()
            .to_owned();

        let waiting = get(&app, &format!("/games/{game}")).await;
        let bot = get(&app, &format!("/games/{against_bot}")).await;

        assert_eq!(
            tag(text(&waiting), "og:description").as_deref(),
            Some("Player 1 is waiting for an opponent")
        );
        assert_eq!(
            tag(text(&bot), "og:description").as_deref(),
            Some("Player 1 vs Medium bot")
        );
    }

    #[sqlx::test]
    async fn what_a_player_typed_cannot_break_out_of_the_tags(pool: PgPool) {
        let app = app(pool);
        let name = "\"><script>alert('x')</script>&";
        let game = started(&app, "ultimate-tic-tac-toe", name).await;

        let reply = get(&app, &format!("/games/{game}")).await;

        let html = text(&reply);
        assert!(!html.contains("<script>"), "{html}");
        assert!(!html.contains("alert('x')"), "{html}");
        assert_eq!(
            tag(html, "og:description").as_deref(),
            Some(format!("ada vs {name} (guest)").as_str())
        );
    }

    #[sqlx::test]
    async fn a_game_without_a_picture_has_only_words(pool: PgPool) {
        let app = app(pool);
        let game = started(&app, "tally", "Grace").await;

        let page = get(&app, &format!("/games/{game}")).await;
        let image = get(&app, &format!("/api/games/{game}/preview.png")).await;

        let html = text(&page);
        assert_eq!(tag(html, "og:title").as_deref(), Some("Tally"));
        assert_eq!(tag(html, "og:image"), None);
        assert_eq!(tag(html, "twitter:card").as_deref(), Some("summary"));
        assert_eq!(image.status, StatusCode::NOT_FOUND);
    }

    #[sqlx::test]
    async fn the_old_address_with_the_kind_and_a_capital_id_open_the_same_page(pool: PgPool) {
        let app = app(pool);
        let game = started(&app, "ultimate-tic-tac-toe", "Grace").await;

        for path in [
            format!("/games/ultimate-tic-tac-toe/{game}"),
            format!("/games/{}", game.to_uppercase()),
            format!("/games/{game}/"),
        ] {
            let reply = get(&app, &path).await;
            assert_eq!(reply.status, StatusCode::OK, "{path}");
            assert_eq!(
                tag(text(&reply), "og:title").as_deref(),
                Some("Ultimate tic-tac-toe"),
                "{path}"
            );
        }
    }

    #[sqlx::test]
    async fn an_address_that_is_no_game_gets_the_page_as_it_is(pool: PgPool) {
        let app = app(pool);
        let game = started(&app, "ultimate-tic-tac-toe", "Grace").await;

        for path in [
            "/games/abcdefghijkm".to_owned(),
            // Not the letters and digits of an id.
            "/games/not_an_id".to_owned(),
            // A kind the server doesn't offer, and one too many parts.
            format!("/games/chess/{game}"),
            format!("/games/ultimate-tic-tac-toe/{game}/more"),
        ] {
            let reply = get(&app, &path).await;
            assert_eq!(reply.status, StatusCode::OK, "{path}");
            assert_eq!(text(&reply), SHELL, "{path}");
        }
    }

    #[sqlx::test]
    async fn a_server_that_was_not_given_the_page_does_not_serve_game_pages(pool: PgPool) {
        let app = TestApp::new(pool, registry());

        let reply = get(&app, "/games/abcdefghijkm").await;

        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }

    #[sqlx::test]
    async fn the_picture_is_a_png_of_the_size_of_a_card_for_each_real_game(pool: PgPool) {
        let app = app(pool);
        for kind in ["long-backgammon", "ultimate-tic-tac-toe"] {
            let started = started_by(&app, &format!("ada-{kind}"), kind, "Grace").await;
            let (_, other) = app
                .register_account(&format!("grace-{kind}"), "correct horse battery")
                .await;
            let waiting = app.create_game(&other, kind).await;

            for game in [started, waiting] {
                // No token.
                let reply = get(&app, &format!("/api/games/{game}/preview.png?rev=1")).await;

                assert_eq!(reply.status, StatusCode::OK, "{kind}");
                assert_eq!(reply.headers[header::CONTENT_TYPE], "image/png");
                assert_eq!(png_size(&reply.body), (1200, 630), "{kind}");
                // The board sits on the dark page: the corner of the card is bare.
                let card = tiny_skia::Pixmap::decode_png(&reply.body).unwrap();
                let corner = card.pixel(0, 0).unwrap();
                assert_eq!(
                    (corner.red(), corner.green(), corner.blue()),
                    (0x16, 0x14, 0x0f),
                    "{kind}"
                );
            }
        }
    }

    #[sqlx::test]
    async fn there_is_no_picture_of_a_game_that_does_not_exist(pool: PgPool) {
        let app = app(pool);

        let reply = get(&app, "/api/games/abcdefghijkm/preview.png").await;

        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }

    #[sqlx::test]
    async fn looking_at_a_game_does_not_take_its_seat(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_account("ada", "correct horse battery").await;
        let game = app.create_game(&ada, "ultimate-tic-tac-toe").await;
        get(&app, &format!("/games/{game}")).await;
        get(&app, &format!("/api/games/{game}/preview.png")).await;
        let (_, grace) = app.register_user().await;

        let joined = app.join_game(&grace, &game).await;

        assert_eq!(joined.status, StatusCode::OK);
        assert_eq!(joined.json["seat"], 1);
    }

    #[sqlx::test]
    async fn a_new_build_of_the_page_is_served_without_a_restart(pool: PgPool) {
        let page = page_file("<html><head></head><body>the old build</body></html>");
        let app = app_with_page(pool, &page);
        let game = {
            let (_, ada) = app.register_account("ada", "correct horse battery").await;
            app.create_game(&ada, "ultimate-tic-tac-toe").await
        };
        let before = get(&app, &format!("/games/{game}")).await;

        std::fs::write(
            &page,
            "<html><head></head><body>the new build</body></html>",
        )
        .unwrap();
        let after = get(&app, &format!("/games/{game}")).await;

        assert!(text(&before).contains("the old build"));
        assert!(text(&after).contains("the new build"));
        // With the tags, which are the game's and not the build's.
        assert_eq!(
            tag(text(&after), "og:title").as_deref(),
            Some("Ultimate tic-tac-toe")
        );
    }

    #[sqlx::test]
    async fn a_page_that_has_gone_missing_is_a_server_error_not_an_empty_page(pool: PgPool) {
        let page = page_file(SHELL);
        let app = app_with_page(pool, &page);
        std::fs::remove_file(&page).unwrap();

        let reply = get(&app, "/games/abcdefghijkm").await;

        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn a_page_that_cannot_be_read_or_has_no_head_is_refused_at_startup() {
        let no_head = page_file("<html></html>");
        let missing = no_head.with_file_name("nothing-here.html");

        assert!(Pages::new(no_head, "https://games.example").is_err());
        assert!(Pages::new(missing, "https://games.example").is_err());
    }
}
