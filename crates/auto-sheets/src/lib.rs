//! Multi-format spreadsheet reading (`xlsx`, `xlsm`, `xlsb`, `xls`, `ods`, `csv`), styled `.xlsx`
//! writing via `craft-opc` + `craft-xml`, and targeted cell modification with formula recalculation.

mod formula;

use craft_opc::{PackageOut, RelsOut};
use craft_sheet::{CellRef, Value, col_letters};
use craft_xlsx::{Cell, CellFormula, CellValue as XlsxCellValue, Limits, Package, Row, SheetKind, StringItem, is_xlsb};
use craft_xml::Writer;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

const CT_WORKBOOK: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const CT_WORKSHEET: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const CT_STYLES: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
const CT_SHARED_STRINGS: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";

const NS_SSML: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Spreadsheet read/write/modify errors.
#[derive(Debug, Error)]
pub enum SheetError {
    #[error("empty workbook: at least one sheet is required")]
    EmptyWorkbook,
    #[error("sheet `{0}` not found")]
    SheetNotFound(String),
    #[error("invalid cell coordinates: row {row}, col {col}")]
    InvalidCoordinates { row: u32, col: u32 },
    #[error("XLSX error: {0}")]
    Xlsx(#[from] craft_xlsx::Error),
    #[error("XLS error: {0}")]
    Xls(#[from] craft_xls::Error),
    #[error("ODS error: {0}")]
    Ods(#[from] craft_ods::Error),
    #[error("OPC packaging error: {0}")]
    Opc(#[from] craft_opc::Error),
}

/// Logical cell scalar value exchanged over JSON / FFI.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CellValue {
    Bool(bool),
    Number(f64),
    Text(String),
    #[default]
    Empty,
}

impl CellValue {
    fn from_sheet_value(v: &Value) -> Self {
        match v {
            Value::Empty => Self::Empty,
            Value::Number(n) => Self::Number(*n),
            Value::Text(s) => Self::Text(s.to_string()),
            Value::Bool(b) => Self::Bool(*b),
            Value::Error(e) => Self::Text(e.as_str().to_owned()),
        }
    }
}

/// Detected container format on [`read`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpreadsheetFormat {
    Xlsx,
    Xls,
    Xlsb,
    Ods,
    Csv,
}

/// One parsed sheet grid (`rows[row][col]`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSheet {
    pub name: String,
    pub rows: Vec<Vec<CellValue>>,
}

/// Result returned by [`read`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub format: SpreadsheetFormat,
    pub sheets: Vec<ReadSheet>,
    pub warnings: Vec<String>,
}

/// Column formatting hint for [`write_xlsx`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    #[default]
    Text,
    Number,
    Euros,
    Date,
    Percent,
}

/// Column header and display formatting for [`write_xlsx`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    #[serde(alias = "titre")]
    pub title: String,
    #[serde(default, alias = "type")]
    pub col_type: ColumnType,
    #[serde(default, alias = "largeur")]
    pub width: Option<f64>,
}

/// Worksheet definition for [`write_xlsx`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    #[serde(alias = "nom")]
    pub name: String,
    #[serde(alias = "colonnes")]
    pub columns: Vec<ColumnSpec>,
    #[serde(alias = "lignes")]
    pub rows: Vec<Vec<CellValue>>,
}

/// Workbook payload for [`write_xlsx`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workbook {
    #[serde(alias = "feuilles")]
    pub sheets: Vec<Sheet>,
}

/// Targeted edit applied to an existing `.xlsx` file by [`modify_xlsx`] (1-based `row` and `col`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    #[serde(alias = "feuille")]
    pub sheet: String,
    #[serde(alias = "ligne")]
    pub row: u32,
    #[serde(alias = "colonne")]
    pub col: u32,
    #[serde(default, alias = "valeur")]
    pub value: Option<CellValue>,
    #[serde(default, alias = "formule")]
    pub formula: Option<String>,
}

/// Reads `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`, or `.csv`/`.tsv` bytes into dense sheet grids.
pub fn read(bytes: &[u8]) -> Result<ReadResult, SheetError> {
    if craft_xls::is_xls(bytes) {
        let res = craft_xls::read(bytes)?;
        let warnings = res.warnings.into_iter().map(|w| w.to_string()).collect();
        let sheets = res
            .workbook
            .sheets
            .into_iter()
            .map(|s| {
                let cells: Vec<(u32, u32, CellValue)> = s
                    .cells
                    .into_iter()
                    .map(|(cref, c)| (cref.row, cref.col, CellValue::from_sheet_value(&c.value)))
                    .collect();
                ReadSheet { name: s.name, rows: materialize_grid(&cells) }
            })
            .collect();
        return Ok(ReadResult { format: SpreadsheetFormat::Xls, sheets, warnings });
    }

    if craft_ods::is_ods(bytes) {
        let book = craft_ods::read(bytes, &craft_ods::Options::default())?;
        let sheets = book
            .sheets
            .into_iter()
            .map(|s| {
                let cells: Vec<(u32, u32, CellValue)> = s
                    .cells
                    .into_iter()
                    .filter(|(_, c)| !c.is_blank() && !c.covered)
                    .map(|(cref, c)| {
                        let v = c.value().map(|val| CellValue::from_sheet_value(&val)).unwrap_or_else(|| {
                            if c.text.is_empty() { CellValue::Empty } else { CellValue::Text(c.text) }
                        });
                        (cref.row, cref.col, v)
                    })
                    .collect();
                ReadSheet { name: s.name, rows: materialize_grid(&cells) }
            })
            .collect();
        return Ok(ReadResult { format: SpreadsheetFormat::Ods, sheets, warnings: Vec::new() });
    }

    if bytes.starts_with(b"PK\x03\x04") {
        let format = if is_xlsb(bytes) { SpreadsheetFormat::Xlsb } else { SpreadsheetFormat::Xlsx };
        let mut pkg = Package::open(bytes, &Limits::default())?;
        let wb = pkg.workbook()?;
        let strings = pkg.shared_strings()?;
        let mut sheets = Vec::new();
        for entry in &wb.sheets {
            if entry.kind != SheetKind::Worksheet {
                continue;
            }
            let mut cells = Vec::new();
            pkg.sheet(entry, |row| {
                for cell in &row.cells {
                    let v = cell.value.resolve(&strings, wb.date_1904);
                    if !v.is_empty() {
                        cells.push((cell.at.row, cell.at.col, CellValue::from_sheet_value(&v)));
                    }
                }
                Ok(())
            })?;
            sheets.push(ReadSheet { name: entry.name.clone(), rows: materialize_grid(&cells) });
        }
        let warnings = pkg.warnings().to_vec();
        return Ok(ReadResult { format, sheets, warnings });
    }

    // Delimited text fallback (CSV / TSV).
    let text = craft_csv::decode_text(bytes);
    let delim = char::from(craft_csv::sniff_delimiter(&text, '"'));
    let raw_rows = craft_csv::records(&text, delim, '"', 1_000_000, 16_384);
    let rows = raw_rows.into_iter().map(|rec| rec.into_iter().map(parse_csv_scalar).collect()).collect();
    Ok(ReadResult {
        format: SpreadsheetFormat::Csv,
        sheets: vec![ReadSheet { name: "Sheet1".into(), rows }],
        warnings: Vec::new(),
    })
}

/// Writes a typed, styled `.xlsx` workbook via `craft-opc` + `craft-xml` (bold `#EEF2F1` header, frozen row 1).
pub fn write_xlsx(book: &Workbook) -> Result<Vec<u8>, SheetError> {
    if book.sheets.is_empty() {
        return Err(SheetError::EmptyWorkbook);
    }

    let mut pkg = PackageOut::default();
    let mut root_rels = RelsOut::default();
    root_rels.add("officeDocument", "xl/workbook.xml", false);
    pkg.rels("", &root_rels);

    let mut shared_strings: Vec<String> = Vec::new();
    let mut string_index: HashMap<String, usize> = HashMap::new();
    let mut intern = |s: &str| -> usize {
        if let Some(&idx) = string_index.get(s) {
            return idx;
        }
        let idx = shared_strings.len();
        shared_strings.push(s.to_owned());
        string_index.insert(s.to_owned(), idx);
        idx
    };

    let mut wb_rels = RelsOut::default();
    let mut wb_writer = Writer::document();
    wb_writer.open("workbook", &[("xmlns", NS_SSML), ("xmlns:r", NS_R)]);
    wb_writer.empty("workbookPr", &[("date1904", "0")]);
    wb_writer.open("sheets", &[]);

    for (idx, sheet) in book.sheets.iter().enumerate() {
        let sheet_num = idx + 1;
        let part_rel = format!("worksheets/sheet{sheet_num}.xml");
        let part_full = format!("xl/{part_rel}");
        let rid = wb_rels.add("worksheet", &part_rel, false);
        let safe_name = sanitize_sheet_name(&sheet.name, sheet_num);
        wb_writer.tag("sheet").attr("name", &safe_name).attr("sheetId", sheet_num).attr("r:id", &rid).empty();

        let sheet_xml = build_sheet_xml(sheet, &mut intern);
        pkg.xml_part(&part_full, CT_WORKSHEET, sheet_xml);
    }
    wb_writer.close();
    wb_writer.close();
    pkg.xml_part("xl/workbook.xml", CT_WORKBOOK, wb_writer.into_bytes());

    wb_rels.add("styles", "styles.xml", false);
    wb_rels.add("sharedStrings", "sharedStrings.xml", false);
    pkg.rels("xl/workbook.xml", &wb_rels);

    pkg.xml_part("xl/styles.xml", CT_STYLES, build_styles_xml());
    pkg.xml_part("xl/sharedStrings.xml", CT_SHARED_STRINGS, build_shared_strings_xml(&shared_strings));

    Ok(pkg.finish()?)
}

/// Applies targeted 1-based cell edits to an `.xlsx` workbook, recalculates formulas, and preserves styles.
pub fn modify_xlsx(bytes: &[u8], edits: &[CellEdit]) -> Result<Vec<u8>, SheetError> {
    let mut doc = craft_xlsx::Document::read(bytes, &Limits::default())?;

    for edit in edits {
        if edit.row == 0 || edit.col == 0 {
            return Err(SheetError::InvalidCoordinates { row: edit.row, col: edit.col });
        }
        let target_ref = CellRef::new(edit.row - 1, edit.col - 1);
        let sheet_idx = doc
            .workbook
            .sheets
            .iter()
            .position(|s| s.name.eq_ignore_ascii_case(&edit.sheet))
            .ok_or_else(|| SheetError::SheetNotFound(edit.sheet.clone()))?;

        let Some(ws) = doc.worksheets.get_mut(sheet_idx).and_then(|o| o.as_mut()) else {
            return Err(SheetError::SheetNotFound(edit.sheet.clone()));
        };

        let row_pos = match ws.rows.binary_search_by_key(&target_ref.row, |r| r.index) {
            Ok(i) => i,
            Err(i) => {
                ws.rows.insert(i, Row { index: target_ref.row, ..Row::default() });
                i
            }
        };
        let row = &mut ws.rows[row_pos];
        let cell_pos = match row.cells.binary_search_by_key(&target_ref.col, |c| c.at.col) {
            Ok(i) => i,
            Err(i) => {
                row.cells.insert(i, Cell { at: target_ref, ..Cell::default() });
                i
            }
        };
        let cell = &mut row.cells[cell_pos];

        if let Some(formula_text) = edit.formula.as_deref() {
            let trimmed = formula_text.trim().strip_prefix('=').unwrap_or(formula_text.trim()).to_owned();
            cell.formula = Some(CellFormula { text: trimmed, ..CellFormula::default() });
        }
        if let Some(val) = &edit.value {
            cell.value = encode_xlsx_cell_value(val, &mut doc.shared_strings);
        }
    }

    // Build evaluation snapshot across all sheets, recalculate formulas, and update cached values.
    let mut grid: Vec<formula::SheetGrid> = Vec::new();
    for (idx, entry) in doc.workbook.sheets.iter().enumerate() {
        let mut vals = HashMap::new();
        let mut formulas = Vec::new();
        if let Some(Some(ws)) = doc.worksheets.get(idx) {
            for row in &ws.rows {
                for cell in &row.cells {
                    let v = cell.value.resolve(&doc.shared_strings, doc.workbook.date_1904);
                    if !v.is_empty() {
                        vals.insert((cell.at.row, cell.at.col), v);
                    }
                    if let Some(f) = &cell.formula
                        && !f.text.is_empty()
                    {
                        formulas.push((cell.at.row, cell.at.col, f.text.clone()));
                    }
                }
            }
        }
        grid.push((entry.name.clone(), vals, formulas));
    }

    formula::recalculate_workbook(&mut grid);

    for (idx, (_, vals, formulas)) in grid.into_iter().enumerate() {
        if formulas.is_empty() {
            continue;
        }
        let Some(Some(ws)) = doc.worksheets.get_mut(idx) else { continue };
        for (r_idx, c_idx, _) in formulas {
            let Some(new_val) = vals.get(&(r_idx, c_idx)) else { continue };
            if let Ok(ri) = ws.rows.binary_search_by_key(&r_idx, |r| r.index)
                && let Ok(ci) = ws.rows[ri].cells.binary_search_by_key(&c_idx, |c| c.at.col)
            {
                let cell = &mut ws.rows[ri].cells[ci];
                cell.value = match new_val {
                    Value::Empty => XlsxCellValue::Empty,
                    Value::Number(n) => XlsxCellValue::Number(*n),
                    Value::Bool(b) => XlsxCellValue::Bool(*b),
                    Value::Text(s) => XlsxCellValue::Text(s.clone()),
                    Value::Error(e) => XlsxCellValue::Error(*e),
                };
            }
        }
    }

    Ok(doc.write()?)
}

fn encode_xlsx_cell_value(v: &CellValue, strings: &mut Vec<StringItem>) -> XlsxCellValue {
    match v {
        CellValue::Empty => XlsxCellValue::Empty,
        CellValue::Number(n) => XlsxCellValue::Number(*n),
        CellValue::Bool(b) => XlsxCellValue::Bool(*b),
        CellValue::Text(t) => {
            let idx = if let Some(pos) = strings.iter().position(|si| si.text.as_ref() == t) {
                pos
            } else {
                let pos = strings.len();
                strings.push(StringItem { text: Arc::from(t.as_str()), ..StringItem::default() });
                pos
            };
            XlsxCellValue::Shared(idx as u32)
        }
    }
}

fn build_sheet_xml(sheet: &Sheet, intern: &mut impl FnMut(&str) -> usize) -> Vec<u8> {
    let mut w = Writer::document();
    w.open("worksheet", &[("xmlns", NS_SSML)]);

    // Freeze row 1.
    w.open("sheetViews", &[]);
    w.open("sheetView", &[("tabSelected", "1"), ("workbookViewId", "0")]);
    w.empty("pane", &[("ySplit", "1"), ("topLeftCell", "A2"), ("activePane", "bottomLeft"), ("state", "frozen")]);
    w.close();
    w.close();

    if !sheet.columns.is_empty() {
        w.open("cols", &[]);
        for (i, col) in sheet.columns.iter().enumerate() {
            let col_num = i + 1;
            let width = col.width.unwrap_or_else(|| (col.title.chars().count() as f64 + 6.0).clamp(12.0, 48.0));
            w.tag("col")
                .attr("min", col_num)
                .attr("max", col_num)
                .attr("width", format!("{width:.2}"))
                .attr("customWidth", "1")
                .empty();
        }
        w.close();
    }

    w.open("sheetData", &[]);

    // Header row (style xf 1 = bold + #EEF2F1 fill).
    w.tag("row").attr("r", 1).open();
    for (c_idx, col) in sheet.columns.iter().enumerate() {
        let cell_ref = format!("{}1", col_letters(c_idx as u32));
        let s_idx = intern(&col.title);
        w.tag("c").attr("r", &cell_ref).attr("t", "s").attr("s", "1").open();
        w.leaf("v", &[], &s_idx.to_string());
        w.close();
    }
    w.close();

    // Data rows (style xfs: 0=text, 2=number, 3=euros, 4=date, 5=percent).
    for (r_offset, row) in sheet.rows.iter().enumerate() {
        let r_num = r_offset + 2;
        w.tag("row").attr("r", r_num).open();
        for (c_idx, val) in row.iter().enumerate() {
            let col_type = sheet.columns.get(c_idx).map_or(ColumnType::Text, |c| c.col_type);
            let cell_ref = format!("{}{r_num}", col_letters(c_idx as u32));
            let style_id = match col_type {
                ColumnType::Text => "0",
                ColumnType::Number => "2",
                ColumnType::Euros => "3",
                ColumnType::Date => "4",
                ColumnType::Percent => "5",
            };
            match (val, col_type) {
                (CellValue::Empty, _) => {}
                (CellValue::Bool(b), _) => {
                    w.tag("c").attr("r", &cell_ref).attr("t", "b").open();
                    w.leaf("v", &[], if *b { "1" } else { "0" });
                    w.close();
                }
                (CellValue::Number(n), ColumnType::Euros) => {
                    w.tag("c").attr("r", &cell_ref).attr("s", style_id).open();
                    w.leaf("v", &[], &format!("{}", n / 100.0));
                    w.close();
                }
                (CellValue::Number(n), ColumnType::Percent) => {
                    w.tag("c").attr("r", &cell_ref).attr("s", style_id).open();
                    w.leaf("v", &[], &format!("{}", n / 10_000.0));
                    w.close();
                }
                (CellValue::Number(n), _) => {
                    w.tag("c").attr("r", &cell_ref).attr("s", style_id).open();
                    w.leaf("v", &[], &format!("{n}"));
                    w.close();
                }
                (CellValue::Text(s), ColumnType::Date) => {
                    if let Some(serial) = iso_date_to_excel_serial(s) {
                        w.tag("c").attr("r", &cell_ref).attr("s", style_id).open();
                        w.leaf("v", &[], &serial.to_string());
                        w.close();
                    } else {
                        let si = intern(s);
                        w.tag("c").attr("r", &cell_ref).attr("t", "s").attr("s", "0").open();
                        w.leaf("v", &[], &si.to_string());
                        w.close();
                    }
                }
                (CellValue::Text(s), _) => {
                    let si = intern(s);
                    w.tag("c").attr("r", &cell_ref).attr("t", "s").attr("s", "0").open();
                    w.leaf("v", &[], &si.to_string());
                    w.close();
                }
            }
        }
        w.close();
    }

    w.close();
    w.close();
    w.into_bytes()
}

fn build_styles_xml() -> Vec<u8> {
    let mut w = Writer::document();
    w.open("styleSheet", &[("xmlns", NS_SSML)]);

    w.open("numFmts", &[("count", "1")]);
    w.empty("numFmt", &[("numFmtId", "164"), ("formatCode", "#,##0.00\\ \"€\"")]);
    w.close();

    w.open("fonts", &[("count", "2")]);
    w.open("font", &[]);
    w.empty("sz", &[("val", "11")]);
    w.empty("name", &[("val", "Inter")]);
    w.close();
    w.open("font", &[]);
    w.empty("b", &[]);
    w.empty("sz", &[("val", "11")]);
    w.empty("name", &[("val", "Inter")]);
    w.close();
    w.close();

    w.open("fills", &[("count", "3")]);
    w.open("fill", &[]);
    w.empty("patternFill", &[("patternType", "none")]);
    w.close();
    w.open("fill", &[]);
    w.empty("patternFill", &[("patternType", "gray125")]);
    w.close();
    w.open("fill", &[]);
    w.open("patternFill", &[("patternType", "solid")]);
    w.empty("fgColor", &[("rgb", "FFEEF2F1")]);
    w.close();
    w.close();
    w.close();

    w.open("borders", &[("count", "1")]);
    w.open("border", &[]);
    w.empty("left", &[]);
    w.empty("right", &[]);
    w.empty("top", &[]);
    w.empty("bottom", &[]);
    w.close();
    w.close();

    w.open("cellStyleXfs", &[("count", "1")]);
    w.empty("xf", &[("numFmtId", "0"), ("fontId", "0"), ("fillId", "0"), ("borderId", "0")]);
    w.close();

    // xfs: 0=default text, 1=bold header, 2=number (0.00), 3=euros (164), 4=date (14), 5=percent (10 = 0.00%)
    w.open("cellXfs", &[("count", "6")]);
    w.empty("xf", &[("numFmtId", "0"), ("fontId", "0"), ("fillId", "0"), ("borderId", "0"), ("xfId", "0")]);
    w.empty(
        "xf",
        &[
            ("numFmtId", "0"),
            ("fontId", "1"),
            ("fillId", "2"),
            ("borderId", "0"),
            ("xfId", "0"),
            ("applyFont", "1"),
            ("applyFill", "1"),
        ],
    );
    w.empty(
        "xf",
        &[
            ("numFmtId", "2"),
            ("fontId", "0"),
            ("fillId", "0"),
            ("borderId", "0"),
            ("xfId", "0"),
            ("applyNumberFormat", "1"),
        ],
    );
    w.empty(
        "xf",
        &[
            ("numFmtId", "164"),
            ("fontId", "0"),
            ("fillId", "0"),
            ("borderId", "0"),
            ("xfId", "0"),
            ("applyNumberFormat", "1"),
        ],
    );
    w.empty(
        "xf",
        &[
            ("numFmtId", "14"),
            ("fontId", "0"),
            ("fillId", "0"),
            ("borderId", "0"),
            ("xfId", "0"),
            ("applyNumberFormat", "1"),
        ],
    );
    w.empty(
        "xf",
        &[
            ("numFmtId", "10"),
            ("fontId", "0"),
            ("fillId", "0"),
            ("borderId", "0"),
            ("xfId", "0"),
            ("applyNumberFormat", "1"),
        ],
    );
    w.close();

    w.close();
    w.into_bytes()
}

fn build_shared_strings_xml(strings: &[String]) -> Vec<u8> {
    let mut w = Writer::document();
    let count = strings.len().to_string();
    w.open("sst", &[("xmlns", NS_SSML), ("count", &count), ("uniqueCount", &count)]);
    for s in strings {
        w.open("si", &[]);
        w.leaf("t", &[], s);
        w.close();
    }
    w.close();
    w.into_bytes()
}

fn materialize_grid(cells: &[(u32, u32, CellValue)]) -> Vec<Vec<CellValue>> {
    if cells.is_empty() {
        return Vec::new();
    }
    let max_r = cells.iter().map(|c| c.0).max().unwrap_or(0) as usize;
    let mut rows: Vec<Vec<CellValue>> = vec![Vec::new(); max_r + 1];
    for (r, c, v) in cells {
        let row = &mut rows[*r as usize];
        let col = *c as usize;
        if row.len() <= col {
            row.resize(col + 1, CellValue::Empty);
        }
        row[col] = v.clone();
    }
    rows
}

fn parse_csv_scalar(s: String) -> CellValue {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return CellValue::Empty;
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return CellValue::Bool(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return CellValue::Bool(false);
    }
    if (!trimmed.starts_with('0') || trimmed == "0" || trimmed.starts_with("0."))
        && let Ok(n) = trimmed.parse::<f64>()
        && n.is_finite()
    {
        return CellValue::Number(n);
    }
    CellValue::Text(s)
}

fn sanitize_sheet_name(raw: &str, idx: usize) -> String {
    let cleaned: String =
        raw.chars().filter(|c| !matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']')).take(31).collect();
    if cleaned.trim().is_empty() { format!("Sheet{idx}") } else { cleaned }
}

fn iso_date_to_excel_serial(iso: &str) -> Option<i64> {
    let parts: Vec<&str> = iso.trim().split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let d: i64 = parts[2].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant civil-from-days inverted relative to 1899-12-30 (Excel 1900 epoch with leap bug >= 1900-03-01).
    let days_since_unix = days_from_civil(y, m, d);
    let unix_1899_12_30 = days_from_civil(1899, 12, 30);
    Some(days_since_unix - unix_1899_12_30)
}

fn days_from_civil(mut y: i64, m: i64, d: i64) -> i64 {
    y -= i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
