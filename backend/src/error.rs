use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

/// Why a request failed. Every handler that can fail returns this.
pub enum ApiError {
    /// The request has no valid access token.
    Unauthorized,
    /// The request is well-formed but its content is not acceptable.
    Invalid(&'static str),
    /// The user is known, but this is not theirs to do.
    Forbidden(&'static str),
    /// There is no such thing.
    NotFound,
    /// The request is fine, but the current state of things doesn't allow it.
    Conflict(&'static str),
    /// Our fault: the database or the system's random source failed.
    Internal,
}

impl ApiError {
    /// For `map_err` on a query: logs the database error and answers 500.
    pub fn database(context: &'static str) -> impl FnOnce(sqlx::Error) -> Self {
        move |err| {
            tracing::error!(%err, "{context}");
            Self::Internal
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                [(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"))],
            )
                .into_response(),
            Self::Invalid(reason) => (StatusCode::UNPROCESSABLE_ENTITY, reason).into_response(),
            Self::Forbidden(reason) => (StatusCode::FORBIDDEN, reason).into_response(),
            Self::NotFound => StatusCode::NOT_FOUND.into_response(),
            Self::Conflict(reason) => (StatusCode::CONFLICT, reason).into_response(),
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
}
