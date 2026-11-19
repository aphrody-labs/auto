//! Navigation sections and stack routes inside the NSH app.

use nsh_core::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Overview,
    Documents,
    Customers,
    Automations,
    Cluster,
}

#[derive(Clone, Default)]
struct NavState {
    stack: Vec<String>,
}

fn nav_state() -> Signal<NavState> {
    global::<NavState>()
}

pub fn open_document_ids() -> Vec<String> {
    nav_state().with(|s| s.stack.clone())
}

pub fn can_go_back() -> bool {
    nav_state().with(|s| !s.stack.is_empty())
}

pub fn push_document(id: impl Into<String>) {
    let id = id.into();
    nav_state().update(|s| {
        if !s.stack.contains(&id) {
            s.stack.push(id);
        }
    });
}

pub fn pop_document() {
    nav_state().update(|s| {
        s.stack.pop();
    });
}

pub fn truncate(depth: usize) {
    nav_state().update(|s| s.stack.truncate(depth));
}
