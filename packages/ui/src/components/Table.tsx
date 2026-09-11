import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Prevent the cell from wrapping (e.g. timestamps). */
  nowrap?: boolean;
  muted?: boolean;
}

export interface TableSelection {
  selected: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
}

// Generic data table: column defs + rows + a stable row key. Optional `selection` adds a checkbox
// column for bulk actions. Presentation only — sorting/filtering stay with the caller.
export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = "No rows.",
  selection
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  selection?: TableSelection;
}) {
  const allSelected = rows.length > 0 && rows.every((row) => selection?.selected.has(rowKey(row)));
  const span = columns.length + (selection ? 1 : 0);

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
          {selection && (
            <th style={{ padding: 8, width: 28 }}>
              <input type="checkbox" checked={allSelected} onChange={selection.onToggleAll} aria-label="Select all" />
            </th>
          )}
          {columns.map((column) => (
            <th key={column.key} style={{ padding: 8, fontWeight: 600 }}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
              {selection && (
                <td style={{ padding: 8 }}>
                  <input
                    type="checkbox"
                    checked={selection.selected.has(key)}
                    onChange={() => selection.onToggle(key)}
                    aria-label={`Select ${key}`}
                  />
                </td>
              )}
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{
                    padding: 8,
                    whiteSpace: column.nowrap ? "nowrap" : undefined,
                    color: column.muted ? "var(--text-muted)" : undefined
                  }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          );
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={span} style={{ padding: 8, color: "var(--text-muted)" }}>
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
