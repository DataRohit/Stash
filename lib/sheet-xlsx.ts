export type ExcelImportReport = {
  worksheet: string;
  worksheetNames: string[];
  rows: number;
  columns: number;
  formulasDowngraded: number;
  numbers: number;
  dates: number;
  booleans: number;
  preview: string[][];
};

function isoDate(value: Date): string {
  return Number.isNaN(value.valueOf()) ? "" : value.toISOString().slice(0, 10);
}

const MAX_EXCEL_FILE_BYTES = 10 * 1024 * 1024;

class ExcelImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExcelImportError";
  }
}

export async function parseExcelFile(
  file: File,
  limits: { maxRows: number; maxCols: number; maxCells: number },
  requestedWorksheet?: string,
): Promise<{ values: string[][]; report: ExcelImportReport }> {
  if (file.size > MAX_EXCEL_FILE_BYTES) {
    throw new ExcelImportError(
      `Workbooks must be ${Math.round(MAX_EXCEL_FILE_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellDates: true,
    cellFormula: true,
    cellNF: false,
    cellStyles: false,
  });
  const worksheetNames = workbook.SheetNames;
  const worksheet =
    (requestedWorksheet && worksheetNames.includes(requestedWorksheet)
      ? requestedWorksheet
      : null) ?? worksheetNames[0];
  if (!worksheet) throw new Error("The workbook has no worksheets.");
  const sheet = workbook.Sheets[worksheet];
  if (!sheet) throw new Error("The selected worksheet is unavailable.");
  const declared = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
  if (declared) {
    const declaredRows = declared.e.r - declared.s.r + 1;
    const declaredCols = declared.e.c - declared.s.c + 1;
    if (
      declaredRows > limits.maxRows ||
      declaredCols > limits.maxCols ||
      declaredRows * declaredCols > limits.maxCells
    ) {
      throw new ExcelImportError(
        `“${worksheet}” is ${declaredRows.toLocaleString()} rows × ${declaredCols.toLocaleString()} columns, which exceeds the ${limits.maxRows.toLocaleString()} row, ${limits.maxCols.toLocaleString()} column, and ${limits.maxCells.toLocaleString()} cell limits. Trim the worksheet and try again.`,
      );
    }
  }
  const range = declared;
  if (!range) {
    return {
      values: [[""]],
      report: {
        worksheet,
        worksheetNames,
        rows: 1,
        columns: 1,
        formulasDowngraded: 0,
        numbers: 0,
        dates: 0,
        booleans: 0,
        preview: [[""]],
      },
    };
  }
  let formulasDowngraded = 0;
  let numbers = 0;
  let dates = 0;
  let booleans = 0;
  const values: string[][] = [];
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const output: string[] = [];
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (!cell) {
        output.push("");
        continue;
      }
      if (cell.f) formulasDowngraded += 1;
      if (cell.t === "d" && cell.v instanceof Date) {
        dates += 1;
        output.push(isoDate(cell.v));
      } else if (cell.t === "n" && typeof cell.v === "number") {
        numbers += 1;
        output.push(String(cell.v));
      } else if (cell.t === "b") {
        booleans += 1;
        output.push(cell.v ? "TRUE" : "FALSE");
      } else {
        output.push(cell.w ?? String(cell.v ?? ""));
      }
    }
    values.push(output);
  }
  return {
    values,
    report: {
      worksheet,
      worksheetNames,
      rows: values.length,
      columns: Math.max(0, ...values.map((row) => row.length)),
      formulasDowngraded,
      numbers,
      dates,
      booleans,
      preview: values.slice(0, 5).map((row) => row.slice(0, 8)),
    },
  };
}
