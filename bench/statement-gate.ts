// Statement counts are deterministic, so any rise fails. Rows read drift with
// unrelated changes, so they fail only past a relative-plus-absolute margin;
// an exact match forced a rebaseline in every commit.

const ROWS_READ_RELATIVE_TOLERANCE = 1.1;
const ROWS_READ_ABSOLUTE_TOLERANCE = 16;

export interface GatedRow {
  operation: string;
  statements: number;
  rowsRead: number;
  baselineStatements: number | null;
  baselineRowsRead: number | null;
}

export interface GateOutcome {
  failures: string[];
  notes: string[];
}

export function rowsReadCeiling(baselineRowsRead: number): number {
  return baselineRowsRead * ROWS_READ_RELATIVE_TOLERANCE + ROWS_READ_ABSOLUTE_TOLERANCE;
}

export function gateRows(rows: readonly GatedRow[]): GateOutcome {
  const outcome: GateOutcome = { failures: [], notes: [] };
  for (const row of rows) gateRow(row, outcome);
  return outcome;
}

function gateRow(row: GatedRow, outcome: GateOutcome): void {
  const { operation, statements, rowsRead, baselineStatements, baselineRowsRead } = row;
  if (baselineStatements !== null) {
    if (statements > baselineStatements) {
      outcome.failures.push(
        `${operation}: ${statements} statements regress frozen baseline ${baselineStatements}`,
      );
    } else if (statements < baselineStatements) {
      outcome.notes.push(
        `${operation}: ${statements} statements below frozen baseline ${baselineStatements}; rebaseline available`,
      );
    }
  }
  if (baselineRowsRead !== null) {
    const ceiling = rowsReadCeiling(baselineRowsRead);
    if (rowsRead > ceiling) {
      outcome.failures.push(
        `${operation}: ${rowsRead} rows read exceed ${ceiling.toFixed(1)} ` +
          `(frozen baseline ${baselineRowsRead} x ${ROWS_READ_RELATIVE_TOLERANCE} + ${ROWS_READ_ABSOLUTE_TOLERANCE})`,
      );
    } else if (rowsRead < baselineRowsRead) {
      outcome.notes.push(
        `${operation}: ${rowsRead} rows read below frozen baseline ${baselineRowsRead}; rebaseline available`,
      );
    }
  }
}
