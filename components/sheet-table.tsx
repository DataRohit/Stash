import type { SheetRenderModel } from "@/lib/doc-projection";
import { columnLabel } from "@/lib/sheet-model";

export function SheetTable({
  model,
  className = "",
}: {
  model: SheetRenderModel;
  className?: string;
}) {
  return (
    <div className={`overflow-auto ${className}`}>
      <table className="w-max min-w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 w-12 border border-hairline bg-surface px-2 py-1.5" />
            {model.columns.map((column, index) => (
              <th
                key={column.id}
                className="sticky top-0 z-10 border border-hairline bg-surface px-2 py-1.5 text-center font-mono text-muted-foreground text-xs"
                style={{ width: column.width, minWidth: column.width }}
              >
                {column.name || columnLabel(index)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row, rowIndex) => (
            <tr key={row.id}>
              <th className="sticky left-0 border border-hairline bg-surface px-2 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                {rowIndex + 1}
              </th>
              {row.values.map((value, colIndex) => (
                <td
                  key={model.columns[colIndex]?.id ?? colIndex}
                  className="whitespace-pre-wrap border border-hairline px-2 py-1.5 align-top"
                >
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
