//! Custom GPUI `Element` rendering the 120 FPS Workflow DAG canvas (`request_layout -> prepaint -> paint`).

use gpui_kit::{
    App, Bounds, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId,
    IntoElement, LayoutId, Pixels, Style, Window, fill, point, px, size,
};

use crate::{store::DagNode, theme::DesktopPalette};

pub struct WorkflowDagCanvas {
    nodes: Vec<DagNode>,
    palette: DesktopPalette,
}

impl Element for WorkflowDagCanvas {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Name("workflow-dag-canvas".into()))
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = gpui_kit::relative(1.0).into();
        style.size.height = px(280.0).into();
        let layout_id = window.request_layout(style, [], cx);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        window.paint_quad(fill(bounds, self.palette.card));

        let card_w = px(188.0);
        let card_h = px(68.0);

        for pair in self.nodes.windows(2) {
            let a = &pair[0];
            let b = &pair[1];
            let start_x = bounds.origin.x + px(a.x) + card_w * 0.5;
            let start_y = bounds.origin.y + px(a.y) + card_h;
            let end_y = bounds.origin.y + px(b.y);
            let rail_h = if end_y > start_y { end_y - start_y } else { px(4.0) };
            let bar = Bounds {
                origin: point(start_x - px(1.5), start_y.min(bounds.origin.y + px(b.y) + px(32.0))),
                size: size(px(3.0), rail_h.max(px(4.0))),
            };
            window.paint_quad(fill(bar, self.palette.border));
        }

        for node in &self.nodes {
            let node_bounds = Bounds {
                origin: point(bounds.origin.x + px(node.x), bounds.origin.y + px(node.y)),
                size: size(card_w, card_h),
            };
            window.paint_quad(fill(node_bounds, self.palette.popover));

            let badge_bounds = Bounds {
                origin: point(node_bounds.origin.x + px(12.0), node_bounds.origin.y + px(14.0)),
                size: size(px(10.0), px(10.0)),
            };
            window.paint_quad(fill(badge_bounds, self.palette.up));
        }
    }
}

pub fn render_dag_canvas(nodes: &[DagNode], palette: DesktopPalette) -> impl IntoElement {
    WorkflowDagCanvas {
        nodes: nodes.to_vec(),
        palette,
    }
}
