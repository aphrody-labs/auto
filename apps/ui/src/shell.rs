//! Top-level NSH navigation stack connecting the workspace and document detail screens.

use nsh_base::nav_stack;
use nsh_core::prelude::*;

use crate::{
    nav,
    pages::{document_detail_screen, workspace_screen},
};

pub fn shell() -> impl IntoElement {
    nav_stack()
        .flex_1()
        .child(workspace_screen())
        .child(each(
            nav::open_document_ids,
            |id: &String| id.clone(),
            |id, depth| {
                document_detail_screen(id.get_untracked())
                    .on_dismiss(move || nav::truncate(depth.get_untracked()))
            },
        ))
}
