"use client";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Download, FileArchive, FileWarning, Sheet } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { DataLoader } from "@/components/ui/data-state";
import { assetFamily } from "@/lib/asset-formats";
import { formatBytes } from "@/lib/format";
import { parseDelimited } from "@/lib/sheet-csv";

function DownloadCard({ node, url }: { node: TreeNode; url: string }) {
  const family = assetFamily(node.mimeType ?? "");
  return (
    <div className="glass flex w-full max-w-lg flex-col items-center gap-4 rounded-lg p-8 text-center">
      {family === "unsafe" ? (
        <FileWarning className="size-10 text-warning" aria-hidden="true" />
      ) : (
        <FileArchive className="size-10 text-info" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <h2 className="truncate font-serif text-xl">{node.name}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {node.mimeType || "Unknown file type"} · {formatBytes(node.size)}
        </p>
        {family === "unsafe" ? (
          <p className="mt-3 text-muted-foreground text-xs">
            This file can contain executable content and is available as a download only.
          </p>
        ) : null}
      </div>
      <a href={url} download={node.name} className={buttonVariants()}>
        <Download className="size-4" aria-hidden="true" />
        Download
      </a>
    </div>
  );
}

function TextViewer({ node, url }: { node: TreeNode; url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("preview-failed");
        return response.text();
      })
      .then(setText)
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [url]);
  useEffect(() => {
    if (text === null || !host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
        ],
      }),
    });
    return () => view.destroy();
  }, [text]);
  if (failed) return <DownloadCard node={node} url={url} />;
  if (text === null) return <DataLoader label={`Loading ${node.name}`} compact />;
  return (
    <div ref={host} className="h-full w-full overflow-hidden rounded-md border border-hairline" />
  );
}

function CsvViewer({
  node,
  url,
  onImport,
}: {
  node: TreeNode;
  url: string;
  onImport?: () => void;
}) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("preview-failed");
        return response.text();
      })
      .then((text) => setRows(parseDelimited(text, node.mimeType?.includes("tab") ? "\t" : ",")))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [node.mimeType, url]);
  if (failed) return <DownloadCard node={node} url={url} />;
  if (!rows) return <DataLoader label={`Loading ${node.name}`} compact />;
  const preview = rows.slice(0, 200);
  const rowCounts = new Map<string, number>();
  const keyedRows = preview.map((row) => {
    const base = row.join("\0");
    const occurrence = rowCounts.get(base) ?? 0;
    rowCounts.set(base, occurrence + 1);
    return { key: `${base}\0${occurrence}`, values: row };
  });
  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Showing {Math.min(rows.length, 200)} of {rows.length} rows
        </p>
        {onImport ? (
          <Button variant="secondary" size="sm" onClick={onImport}>
            <Sheet className="size-4" aria-hidden="true" />
            Import as spreadsheet
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline">
        <table className="w-max min-w-full border-collapse text-xs">
          <tbody>
            {keyedRows.map((row) => {
              const cellCounts = new Map<string, number>();
              return (
                <tr key={row.key}>
                  {row.values.slice(0, 50).map((cell) => {
                    const occurrence = cellCounts.get(cell) ?? 0;
                    cellCounts.set(cell, occurrence + 1);
                    return (
                      <td
                        key={`${cell}\0${occurrence}`}
                        className="max-w-64 truncate border border-hairline px-3 py-2"
                      >
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AttachmentViewer({
  node,
  url,
  onImportCsv,
}: {
  node: TreeNode;
  url: string;
  onImportCsv?: () => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const family = assetFamily(node.mimeType ?? "");
  if (previewFailed) return <DownloadCard node={node} url={url} />;
  if (family === "image") {
    return (
      <Image
        src={url}
        alt={node.name}
        width={1600}
        height={1200}
        unoptimized
        onError={() => setPreviewFailed(true)}
        className="max-h-full max-w-full rounded-md border border-hairline object-contain"
      />
    );
  }
  if (family === "pdf") {
    return (
      <iframe
        src={url}
        title={`Preview ${node.name}`}
        sandbox="allow-same-origin"
        onError={() => setPreviewFailed(true)}
        className="h-full min-h-96 w-full rounded-md border border-hairline bg-white"
      />
    );
  }
  if (family === "text") return <TextViewer node={node} url={url} />;
  if (family === "csv") return <CsvViewer node={node} url={url} onImport={onImportCsv} />;
  if (family === "audio")
    return (
      <audio
        src={url}
        controls
        preload="none"
        onError={() => setPreviewFailed(true)}
        className="w-full max-w-2xl"
      >
        <track kind="captions" srcLang="en" label="Captions unavailable" />
      </audio>
    );
  if (family === "video")
    return (
      <video
        src={url}
        controls
        preload="none"
        onError={() => setPreviewFailed(true)}
        className="max-h-full max-w-full rounded-md border border-hairline"
      >
        <track kind="captions" srcLang="en" label="Captions unavailable" />
      </video>
    );
  return <DownloadCard node={node} url={url} />;
}
