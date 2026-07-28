// Opt-in TypeScript language support. Nothing in this module runs unless the
// user enables a project: no process, no threads, no watchers. See client.rs
// for the protocol conversation and state.rs for per-project supervision.

pub mod check;
pub mod client;
pub mod commands;
pub mod protocol;
pub mod resolve;
pub mod state;
pub mod types;
pub mod uri;

pub use state::LspState;
