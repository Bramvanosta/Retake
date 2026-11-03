/**
 * L5.12c: `DataTable` (R4-Library's detail: a component's slots and params) — a native table: its caption (visible, or
 * hidden and still the table's name), column headers `th scope="col"`, each row's first cell its header `th scope="row"`;
 * a cell without a value says so with a quiet dash (never an empty cell a screen reader skips silently). No inner scroll:
 * a long cell wraps. `ColorField` lives in ColorField.tsx.
 */
import type { ReactNode } from 'react';
import { shown } from '../bits.js';

export interface DataColumn {
  key: string;
  label: ReactNode;
  /** Figures (tabular, right-aligned): a count, a length. */
  numeric?: boolean;
}

export interface DataRow {
  key: string;
  /** One cell per column, in order; `null` / `undefined`: no value (a dash). The first cell heads its row. */
  cells: ReactNode[];
}

const empty = (v: ReactNode) => v === null || v === undefined || v === '';

export function DataTable({ caption, captionHidden, columns, rows, testId }: { caption: ReactNode; captionHidden?: boolean; columns: DataColumn[]; rows: DataRow[]; testId?: string }) {
  return (
    <div className="k-table-wrap">
      <table className="k-table" data-testid={testId}>
        <caption className={captionHidden ? 'k-sr' : 'k-table-caption'}>{shown(caption)}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'k-table-num' : undefined}>
                {shown(c.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {columns.map((c, i) =>
                i === 0 ? (
                  <th key={c.key} scope="row">
                    {empty(r.cells[i]) ? <span className="k-table-none">—</span> : shown(r.cells[i])}
                  </th>
                ) : (
                  <td key={c.key} className={c.numeric ? 'k-table-num' : undefined}>
                    {empty(r.cells[i]) ? <span className="k-table-none">—</span> : shown(r.cells[i])}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
