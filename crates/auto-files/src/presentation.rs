use std::sync::Arc;

use auto_docs::{SlidePdf, render_pptx_pdf};
use craft_pptx::{
    Defaults, LayoutId, Paragraph, PhType, Placeholder, Plain, Presentation, Shape, ShapeId, Slide, SlideId, TextBody,
    Xfrm, export, import, walk,
};
use serde::{Deserialize, Serialize};

use crate::FileError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum BulletInput {
    Text(String),
    Detailed {
        text: String,
        #[serde(default)]
        level: Option<u8>,
    },
}

impl BulletInput {
    fn text_and_level(&self) -> (&str, u8) {
        match self {
            BulletInput::Text(s) => (s.as_str(), 0),
            BulletInput::Detailed { text, level } => (text.as_str(), level.unwrap_or(0).min(8)),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSlide {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub bullets: Vec<BulletInput>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPresentation {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub slides: Vec<NewSlide>,
}

fn text_shape(id: u32, name: &str, xfrm: Xfrm, ph: PhType, idx: u32, body: TextBody) -> Shape {
    Shape {
        id: ShapeId(id),
        name: name.to_owned(),
        xfrm: Some(xfrm),
        ph: Some(Placeholder { kind: ph, idx, ..Default::default() }),
        text: Some(body),
        ..Default::default()
    }
}

pub fn create_pptx(input: &NewPresentation) -> Result<Vec<u8>, FileError> {
    let mut pres = Presentation::default();
    let (master, max_id) = Plain.master(pres.slide_size, 1);
    let layout_id = master.layouts.first().map_or(LayoutId(2), |l| l.id);
    pres.masters.push(Arc::new(master));
    let mut next_id = max_id.saturating_add(1);

    let title_top = input.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let subtitle_top = input.subtitle.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(title) = title_top {
        pres.props.title = title.to_owned();
    }

    let mut slides = Vec::new();
    if title_top.is_some() || subtitle_top.is_some() {
        let mut shapes = Vec::new();
        if let Some(title) = title_top {
            let sid = next_id;
            next_id += 1;
            shapes.push(text_shape(
                sid,
                "Title",
                Xfrm { x: 64.0, y: 150.0, w: 832.0, h: 90.0, ..Default::default() },
                PhType::CtrTitle,
                0,
                TextBody::from_text(title),
            ));
        }
        if let Some(sub) = subtitle_top {
            let sid = next_id;
            next_id += 1;
            shapes.push(text_shape(
                sid,
                "Subtitle",
                Xfrm { x: 64.0, y: 260.0, w: 832.0, h: 64.0, ..Default::default() },
                PhType::SubTitle,
                1,
                TextBody::from_text(sub),
            ));
        }
        let slide_id = next_id;
        next_id += 1;
        slides.push(Arc::new(Slide {
            id: SlideId(slide_id),
            layout: layout_id,
            name: title_top.unwrap_or("Cover").to_owned(),
            shapes,
            ..Default::default()
        }));
    }

    for (idx, item) in input.slides.iter().enumerate() {
        let mut shapes = Vec::new();
        if let Some(stitle) = item.title.as_deref().filter(|s| !s.trim().is_empty()) {
            let sid = next_id;
            next_id += 1;
            shapes.push(text_shape(
                sid,
                "Title",
                Xfrm { x: 48.0, y: 36.0, w: 864.0, h: 64.0, ..Default::default() },
                PhType::Title,
                0,
                TextBody::from_text(stitle),
            ));
        }
        if !item.bullets.is_empty() {
            let sid = next_id;
            next_id += 1;
            let paragraphs = item
                .bullets
                .iter()
                .map(|b| {
                    let (txt, lvl) = b.text_and_level();
                    let mut p = Paragraph::new(txt);
                    p.level = lvl;
                    p
                })
                .collect();
            let body = TextBody { paragraphs, ..Default::default() };
            shapes.push(text_shape(
                sid,
                "Content",
                Xfrm { x: 48.0, y: 112.0, w: 864.0, h: 380.0, ..Default::default() },
                PhType::Body,
                1,
                body,
            ));
        }
        let slide_id = next_id;
        next_id += 1;
        let notes = item.notes.as_deref().map(TextBody::from_text).unwrap_or_default();
        slides.push(Arc::new(Slide {
            id: SlideId(slide_id),
            layout: layout_id,
            name: item.title.clone().unwrap_or_else(|| format!("Slide {}", idx + 1)),
            shapes,
            notes,
            ..Default::default()
        }));
    }

    pres.slides = slides;
    pres.next_id = next_id;
    Ok(export(&pres, &Plain)?)
}

pub fn pptx_text(bytes: &[u8]) -> Result<Vec<String>, FileError> {
    let pres = import(bytes, &Plain)?;
    let mut out = Vec::with_capacity(pres.slides.len());
    for slide in &pres.slides {
        let mut lines = Vec::new();
        walk(&slide.shapes, &mut |shape, _| {
            if let Some(body) = &shape.text {
                let text = body.text();
                if !text.trim().is_empty() {
                    lines.push(text);
                }
            }
        });
        let notes = slide.notes_text();
        if !notes.trim().is_empty() {
            lines.push(notes);
        }
        out.push(lines.join("\n"));
    }
    Ok(out)
}

pub fn pptx_to_pdf(bytes: &[u8]) -> Result<Vec<u8>, FileError> {
    let pres = import(bytes, &Plain)?;
    let mut slides_pdf = Vec::with_capacity(pres.slides.len());
    for slide in &pres.slides {
        let title_raw = slide.title();
        let title = (!title_raw.trim().is_empty()).then_some(title_raw);
        let mut bullets = Vec::new();
        let mut skip_first_title = title.is_some();
        walk(&slide.shapes, &mut |shape, _| {
            if skip_first_title && shape.ph_type().is_some_and(PhType::is_title) {
                skip_first_title = false;
                return;
            }
            if let Some(body) = &shape.text {
                for para in &body.paragraphs {
                    let t = para.text();
                    if !t.trim().is_empty() {
                        bullets.push((t, para.level));
                    }
                }
            }
        });
        let notes_raw = slide.notes_text();
        let notes = (!notes_raw.trim().is_empty()).then_some(notes_raw);
        slides_pdf.push(SlidePdf { title, bullets, notes });
    }
    Ok(render_pptx_pdf((!pres.props.title.trim().is_empty()).then_some(pres.props.title.as_str()), &slides_pdf)?)
}
