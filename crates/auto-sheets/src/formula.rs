//! Spreadsheet formula evaluator supporting arithmetic, comparisons, cell/range refs,
//! and `SUM`, `AVG`/`AVERAGE`, `COUNT`, `MIN`, `MAX`, `IF`.

use craft_sheet::{CellRef, Range, Value};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
enum EvalVal {
    Num(f64),
    Bool(bool),
    Text(String),
    Empty,
}

impl EvalVal {
    fn from_value(v: &Value) -> Self {
        match v {
            Value::Empty => Self::Empty,
            Value::Number(n) => Self::Num(*n),
            Value::Bool(b) => Self::Bool(*b),
            Value::Text(s) => Self::Text(s.to_string()),
            Value::Error(e) => Self::Text(e.as_str().to_owned()),
        }
    }

    fn as_num(&self) -> f64 {
        match self {
            Self::Num(n) => *n,
            Self::Bool(true) => 1.0,
            Self::Bool(false) | Self::Empty => 0.0,
            Self::Text(s) => s.trim().parse::<f64>().unwrap_or(0.0),
        }
    }

    fn as_bool(&self) -> bool {
        match self {
            Self::Bool(b) => *b,
            Self::Num(n) => *n != 0.0,
            Self::Empty => false,
            Self::Text(s) => matches!(s.trim().to_ascii_uppercase().as_str(), "TRUE" | "1"),
        }
    }

    fn into_value(self) -> Value {
        match self {
            Self::Num(n) => Value::number(n),
            Self::Bool(b) => Value::Bool(b),
            Self::Text(s) => Value::text(s),
            Self::Empty => Value::Empty,
        }
    }
}

pub type CellValues = HashMap<(u32, u32), Value>;
pub type FormulaCell = (u32, u32, String);
pub type SheetGrid = (String, CellValues, Vec<FormulaCell>);
pub type SheetSnapshot = (String, CellValues);

/// Evaluates all formula cells across sheets using multi-pass convergence.
pub fn recalculate_workbook(sheets: &mut [SheetGrid]) {
    for _pass in 0..8 {
        let mut changed = false;
        let snapshot: Vec<SheetSnapshot> = sheets.iter().map(|(n, vals, _)| (n.clone(), vals.clone())).collect();

        for (s_idx, sheet) in sheets.iter_mut().enumerate() {
            let formulas = sheet.2.clone();
            for (row, col, expr) in formulas {
                let eval = evaluate(&expr, s_idx, &snapshot);
                if let Some(val) = eval {
                    let entry = sheet.1.get(&(row, col));
                    if entry != Some(&val) {
                        sheet.1.insert((row, col), val);
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
}

fn evaluate(formula: &str, current_sheet: usize, sheets: &[SheetSnapshot]) -> Option<Value> {
    let src = formula.trim().strip_prefix('=').unwrap_or(formula.trim());
    if src.is_empty() {
        return None;
    }
    let mut parser = Parser { src: src.as_bytes(), pos: 0, current_sheet, sheets };
    let val = parser.parse_comparison().ok()?;
    parser.skip_ws();
    if parser.pos == parser.src.len() { Some(val.into_value()) } else { None }
}

struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
    current_sheet: usize,
    sheets: &'a [SheetSnapshot],
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.src.len() && self.src[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.src.get(self.pos).copied()
    }

    fn starts_with(&self, s: &[u8]) -> bool {
        self.src[self.pos..].starts_with(s)
    }

    fn parse_comparison(&mut self) -> Result<EvalVal, ()> {
        let left = self.parse_additive()?;
        self.skip_ws();
        let op = if self.starts_with(b"<=") {
            self.pos += 2;
            Some("<=")
        } else if self.starts_with(b">=") {
            self.pos += 2;
            Some(">=")
        } else if self.starts_with(b"<>") || self.starts_with(b"!=") {
            self.pos += 2;
            Some("<>")
        } else if self.starts_with(b"==") {
            self.pos += 2;
            Some("=")
        } else if matches!(self.src.get(self.pos), Some(b'=' | b'<' | b'>')) {
            let s = match self.src[self.pos] {
                b'=' => "=",
                b'<' => "<",
                _ => ">",
            };
            self.pos += 1;
            Some(s)
        } else {
            None
        };

        let Some(op) = op else { return Ok(left) };
        let right = self.parse_additive()?;
        let res = match (&left, &right) {
            (EvalVal::Text(a), EvalVal::Text(b)) => match op {
                "=" => a.eq_ignore_ascii_case(b),
                "<>" => !a.eq_ignore_ascii_case(b),
                "<" => a < b,
                "<=" => a <= b,
                ">" => a > b,
                ">=" => a >= b,
                _ => false,
            },
            _ => {
                let (a, b) = (left.as_num(), right.as_num());
                match op {
                    "=" => (a - b).abs() < 1e-12,
                    "<>" => (a - b).abs() >= 1e-12,
                    "<" => a < b,
                    "<=" => a <= b,
                    ">" => a > b,
                    ">=" => a >= b,
                    _ => false,
                }
            }
        };
        Ok(EvalVal::Bool(res))
    }

    fn parse_additive(&mut self) -> Result<EvalVal, ()> {
        let mut acc = self.parse_multiplicative()?;
        loop {
            match self.peek() {
                Some(b'+') => {
                    self.pos += 1;
                    acc = EvalVal::Num(acc.as_num() + self.parse_multiplicative()?.as_num());
                }
                Some(b'-') => {
                    self.pos += 1;
                    acc = EvalVal::Num(acc.as_num() - self.parse_multiplicative()?.as_num());
                }
                _ => break,
            }
        }
        Ok(acc)
    }

    fn parse_multiplicative(&mut self) -> Result<EvalVal, ()> {
        let mut acc = self.parse_unary()?;
        loop {
            match self.peek() {
                Some(b'*') => {
                    self.pos += 1;
                    acc = EvalVal::Num(acc.as_num() * self.parse_unary()?.as_num());
                }
                Some(b'/') => {
                    self.pos += 1;
                    let denom = self.parse_unary()?.as_num();
                    if denom == 0.0 {
                        return Ok(EvalVal::Text("#DIV/0!".into()));
                    }
                    acc = EvalVal::Num(acc.as_num() / denom);
                }
                _ => break,
            }
        }
        Ok(acc)
    }

    fn parse_unary(&mut self) -> Result<EvalVal, ()> {
        match self.peek() {
            Some(b'-') => {
                self.pos += 1;
                Ok(EvalVal::Num(-self.parse_unary()?.as_num()))
            }
            Some(b'+') => {
                self.pos += 1;
                self.parse_unary()
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<EvalVal, ()> {
        match self.peek() {
            Some(b'(') => {
                self.pos += 1;
                let v = self.parse_comparison()?;
                if self.peek() != Some(b')') {
                    return Err(());
                }
                self.pos += 1;
                Ok(v)
            }
            Some(b'"') => self.parse_string(),
            Some(c) if c.is_ascii_digit() || c == b'.' => self.parse_number(),
            Some(_) => self.parse_ident_or_ref(),
            None => Err(()),
        }
    }

    fn parse_string(&mut self) -> Result<EvalVal, ()> {
        self.pos += 1;
        let mut s = String::new();
        while self.pos < self.src.len() {
            let b = self.src[self.pos];
            self.pos += 1;
            if b == b'"' {
                if self.src.get(self.pos) == Some(&b'"') {
                    s.push('"');
                    self.pos += 1;
                } else {
                    return Ok(EvalVal::Text(s));
                }
            } else {
                s.push(char::from(b));
            }
        }
        Err(())
    }

    fn parse_number(&mut self) -> Result<EvalVal, ()> {
        let start = self.pos;
        while self.pos < self.src.len() && (self.src[self.pos].is_ascii_digit() || self.src[self.pos] == b'.') {
            self.pos += 1;
        }
        let s = std::str::from_utf8(&self.src[start..self.pos]).map_err(|_| ())?;
        s.parse::<f64>().map(EvalVal::Num).map_err(|_| ())
    }

    fn parse_ident_or_ref(&mut self) -> Result<EvalVal, ()> {
        self.skip_ws();
        // Quoted sheet prefix: `'Sheet Name'!A1`
        if self.src.get(self.pos) == Some(&b'\'') {
            self.pos += 1;
            let start = self.pos;
            while self.pos < self.src.len() && self.src[self.pos] != b'\'' {
                self.pos += 1;
            }
            let sheet_name = std::str::from_utf8(&self.src[start..self.pos]).map_err(|_| ())?.to_owned();
            if self.src.get(self.pos) != Some(&b'\'') || self.src.get(self.pos + 1) != Some(&b'!') {
                return Err(());
            }
            self.pos += 2;
            let cell = self.parse_cell_token()?;
            let idx = self.resolve_sheet(&sheet_name)?;
            return Ok(self.get_cell_val(idx, cell));
        }

        let start = self.pos;
        while self.pos < self.src.len()
            && (self.src[self.pos].is_ascii_alphanumeric() || matches!(self.src[self.pos], b'_' | b'$' | b'.'))
        {
            self.pos += 1;
        }
        let token = std::str::from_utf8(&self.src[start..self.pos]).map_err(|_| ())?.to_owned();
        if token.is_empty() {
            return Err(());
        }

        if self.src.get(self.pos) == Some(&b'!') {
            self.pos += 1;
            let cell = self.parse_cell_token()?;
            let idx = self.resolve_sheet(&token)?;
            return Ok(self.get_cell_val(idx, cell));
        }

        self.skip_ws();
        if self.src.get(self.pos) == Some(&b'(') {
            return self.parse_function(&token);
        }

        if token.eq_ignore_ascii_case("TRUE") {
            return Ok(EvalVal::Bool(true));
        }
        if token.eq_ignore_ascii_case("FALSE") {
            return Ok(EvalVal::Bool(false));
        }
        let cleaned = token.replace('$', "");
        let cell = CellRef::parse(&cleaned).ok_or(())?;
        Ok(self.get_cell_val(self.current_sheet, cell))
    }

    fn parse_cell_token(&mut self) -> Result<CellRef, ()> {
        let start = self.pos;
        while self.pos < self.src.len() && (self.src[self.pos].is_ascii_alphanumeric() || self.src[self.pos] == b'$') {
            self.pos += 1;
        }
        let tok = std::str::from_utf8(&self.src[start..self.pos]).map_err(|_| ())?.replace('$', "");
        CellRef::parse(&tok).ok_or(())
    }

    fn resolve_sheet(&self, name: &str) -> Result<usize, ()> {
        self.sheets.iter().position(|(n, _)| n.eq_ignore_ascii_case(name)).ok_or(())
    }

    fn get_cell_val(&self, sheet_idx: usize, cell: CellRef) -> EvalVal {
        self.sheets
            .get(sheet_idx)
            .and_then(|(_, map)| map.get(&(cell.row, cell.col)))
            .map(EvalVal::from_value)
            .unwrap_or(EvalVal::Empty)
    }

    fn parse_function(&mut self, name: &str) -> Result<EvalVal, ()> {
        self.pos += 1; // consume '('
        let upper = name.to_ascii_uppercase();
        if upper == "IF" {
            let cond = self.parse_comparison()?;
            let when_true = if self.peek() == Some(b',') || self.peek() == Some(b';') {
                self.pos += 1;
                self.parse_comparison()?
            } else {
                EvalVal::Bool(true)
            };
            let when_false = if self.peek() == Some(b',') || self.peek() == Some(b';') {
                self.pos += 1;
                self.parse_comparison()?
            } else {
                EvalVal::Bool(false)
            };
            if self.peek() != Some(b')') {
                return Err(());
            }
            self.pos += 1;
            return Ok(if cond.as_bool() { when_true } else { when_false });
        }

        let vals = self.parse_arg_series()?;
        if self.peek() != Some(b')') {
            return Err(());
        }
        self.pos += 1;

        let nums: Vec<f64> = vals
            .iter()
            .filter_map(|v| match v {
                EvalVal::Num(n) => Some(*n),
                _ => None,
            })
            .collect();

        match upper.as_str() {
            "SUM" => Ok(EvalVal::Num(nums.iter().sum())),
            "AVG" | "AVERAGE" => {
                if nums.is_empty() {
                    Ok(EvalVal::Num(0.0))
                } else {
                    Ok(EvalVal::Num(nums.iter().sum::<f64>() / nums.len() as f64))
                }
            }
            "COUNT" => Ok(EvalVal::Num(nums.len() as f64)),
            "MIN" => Ok(EvalVal::Num(nums.iter().copied().reduce(f64::min).unwrap_or(0.0))),
            "MAX" => Ok(EvalVal::Num(nums.iter().copied().reduce(f64::max).unwrap_or(0.0))),
            _ => Err(()),
        }
    }

    fn parse_arg_series(&mut self) -> Result<Vec<EvalVal>, ()> {
        let mut out = Vec::new();
        if self.peek() == Some(b')') {
            return Ok(out);
        }
        loop {
            self.skip_ws();
            let saved = self.pos;
            if let Ok(expanded) = self.try_parse_range() {
                out.extend(expanded);
            } else {
                self.pos = saved;
                out.push(self.parse_comparison()?);
            }
            match self.peek() {
                Some(b',' | b';') => self.pos += 1,
                _ => break,
            }
        }
        Ok(out)
    }

    fn try_parse_range(&mut self) -> Result<Vec<EvalVal>, ()> {
        self.skip_ws();
        let start = self.pos;
        let mut sheet_idx = self.current_sheet;
        if self.src.get(self.pos) == Some(&b'\'') {
            self.pos += 1;
            let ns = self.pos;
            while self.pos < self.src.len() && self.src[self.pos] != b'\'' {
                self.pos += 1;
            }
            let sname = std::str::from_utf8(&self.src[ns..self.pos]).map_err(|_| ())?;
            if self.src.get(self.pos) != Some(&b'\'') || self.src.get(self.pos + 1) != Some(&b'!') {
                self.pos = start;
                return Err(());
            }
            self.pos += 2;
            sheet_idx = self.resolve_sheet(sname)?;
        } else {
            let mut probe = self.pos;
            while probe < self.src.len() && (self.src[probe].is_ascii_alphanumeric() || self.src[probe] == b'_') {
                probe += 1;
            }
            if self.src.get(probe) == Some(&b'!') {
                let sname = std::str::from_utf8(&self.src[self.pos..probe]).map_err(|_| ())?;
                self.pos = probe + 1;
                sheet_idx = self.resolve_sheet(sname)?;
            }
        }

        let s_tok = self.parse_cell_token().map_err(|_| {
            self.pos = start;
        })?;
        self.skip_ws();
        if self.src.get(self.pos) != Some(&b':') {
            self.pos = start;
            return Err(());
        }
        self.pos += 1;
        let e_tok = self.parse_cell_token()?;
        let range = Range::new(s_tok, e_tok);
        let r0 = range.first.row.min(range.last.row);
        let r1 = range.first.row.max(range.last.row);
        let c0 = range.first.col.min(range.last.col);
        let c1 = range.first.col.max(range.last.col);
        let mut vals = Vec::new();
        if let Some((_, map)) = self.sheets.get(sheet_idx) {
            for r in r0..=r1 {
                for c in c0..=c1 {
                    if let Some(v) = map.get(&(r, c)) {
                        vals.push(EvalVal::from_value(v));
                    }
                }
            }
        }
        Ok(vals)
    }
}
