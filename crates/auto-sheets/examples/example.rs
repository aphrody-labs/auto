use auto_sheets::{CellValue, ColumnSpec, ColumnType, Sheet, Workbook, read, write_xlsx};

fn main() {
    let book = Workbook {
        sheets: vec![Sheet {
            name: "Summary".into(),
            columns: vec![
                ColumnSpec { title: "Label".into(), col_type: ColumnType::Text, width: Some(24.0) },
                ColumnSpec { title: "Total".into(), col_type: ColumnType::Euros, width: Some(16.0) },
            ],
            rows: vec![vec![CellValue::Text("Q4 Sales".into()), CellValue::Number(245_000.0)]],
        }],
    };
    let bytes = write_xlsx(&book).expect("write xlsx");
    let parsed = read(&bytes).expect("read xlsx");
    println!("wrote {} bytes, read {} sheets", bytes.len(), parsed.sheets.len());
}
