use auto_sheets::{
    CellEdit, CellValue, ColumnSpec, ColumnType, Sheet, SpreadsheetFormat, Workbook, modify_xlsx, read, write_xlsx,
};

#[test]
fn writes_and_reads_styled_xlsx_and_csv() {
    let book = Workbook {
        sheets: vec![Sheet {
            name: "Invoices".into(),
            columns: vec![
                ColumnSpec { title: "Number".into(), col_type: ColumnType::Text, width: Some(18.0) },
                ColumnSpec { title: "Amount".into(), col_type: ColumnType::Euros, width: None },
                ColumnSpec { title: "Date".into(), col_type: ColumnType::Date, width: None },
                ColumnSpec { title: "Rate".into(), col_type: ColumnType::Percent, width: None },
            ],
            rows: vec![vec![
                CellValue::Text("INV-01".into()),
                CellValue::Number(123_450.0),
                CellValue::Text("2026-10-22".into()),
                CellValue::Number(2000.0),
            ]],
        }],
    };

    let xlsx = write_xlsx(&book).unwrap();
    let res = read(&xlsx).unwrap();
    assert_eq!(res.format, SpreadsheetFormat::Xlsx);
    assert_eq!(res.sheets[0].name, "Invoices");
    assert_eq!(res.sheets[0].rows[0][0], CellValue::Text("Number".into()));
    assert_eq!(res.sheets[0].rows[1][1], CellValue::Number(1234.5));
    assert_eq!(res.sheets[0].rows[1][3], CellValue::Number(0.2));

    let csv = b"item;qty;price\r\nCable;3;4.5\r\n";
    let csv_res = read(csv).unwrap();
    assert_eq!(csv_res.format, SpreadsheetFormat::Csv);
    assert_eq!(csv_res.sheets[0].rows[1][1], CellValue::Number(3.0));
}

#[test]
fn modifies_cells_and_recalculates_formulas() {
    let book = Workbook {
        sheets: vec![Sheet {
            name: "Budget".into(),
            columns: vec![
                ColumnSpec { title: "Item".into(), col_type: ColumnType::Text, width: None },
                ColumnSpec { title: "Cost".into(), col_type: ColumnType::Number, width: None },
            ],
            rows: vec![
                vec![CellValue::Text("A".into()), CellValue::Number(100.0)],
                vec![CellValue::Text("B".into()), CellValue::Number(200.0)],
                vec![CellValue::Text("Total".into()), CellValue::Number(0.0)],
                vec![CellValue::Text("Status".into()), CellValue::Text(String::new())],
            ],
        }],
    };
    let xlsx = write_xlsx(&book).unwrap();
    let updated = modify_xlsx(
        &xlsx,
        &[
            CellEdit { sheet: "Budget".into(), row: 2, col: 2, value: Some(CellValue::Number(150.0)), formula: None },
            CellEdit { sheet: "Budget".into(), row: 4, col: 2, value: None, formula: Some("=SUM(B2:B3)".into()) },
            CellEdit {
                sheet: "Budget".into(),
                row: 5,
                col: 2,
                value: None,
                formula: Some("=IF(B4>300,\"OK\",\"LOW\")".into()),
            },
        ],
    )
    .unwrap();

    let res = read(&updated).unwrap();
    assert_eq!(res.sheets[0].rows[1][1], CellValue::Number(150.0));
    assert_eq!(res.sheets[0].rows[3][1], CellValue::Number(350.0));
    assert_eq!(res.sheets[0].rows[4][1], CellValue::Text("OK".into()));
}
