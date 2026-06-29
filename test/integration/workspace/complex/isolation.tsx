import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { ReactNode } from "react";

enum Status { Idle = "idle", Loading = "loading", Done = "done" }

interface Row<T> { id: string; value: T; label?: string }
interface TableProps<T> {
rows: Row<T>[];
title?: string;
onPick: (id: string) => void;
render?: (value: T) => ReactNode;
}

function clamp<N extends number>(n: N, lo: number, hi: number): number {
return Math.min(hi, Math.max(lo, n));
}

const css = (strings: TemplateStringsArray, ...v: unknown[]) => strings.join("");

export function DataTable<T>({ rows, title, onPick, render }: TableProps<T>) {
const [status, setStatus] = useState<Status>(Status.Idle);
const [selected, setSelected] = useState<string | null>(null);
const containerRef = useRef<HTMLDivElement | null>(null);

useEffect(() => {
setStatus(rows.length === 0 ? Status.Idle : Status.Done);
}, [rows]);

const visible = useMemo(() => rows.filter((r) => r?.value != null), [rows]);

const handlePick = useCallback((id: string) => {
setSelected(id);
onPick?.(id);
}, [onPick]);

const theme = css`color: ${selected ?? "inherit"}; padding: ${clamp(rows.length, 0, 8)}px;`;

return (
<div ref={containerRef} className="table" data-status={status} title={theme}>
{title ? <h2>{title}</h2> : <></>}
{visible.length === 0 ? (
<p className="empty">No rows</p>
) : (
<table>
<tbody>
{visible.map((r) => (
<tr key={r.id} className={r.id === selected ? "sel" : undefined} onClick={() => handlePick(r.id)}>
<td>{r.label ?? r.id}</td>
<td>{render ? render(r.value) : String(r.value)}</td>
</tr>
))}
</tbody>
</table>
)}
{status === Status.Loading && <span>{/* spinner */}…</span>}
</div>
);
}