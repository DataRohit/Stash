"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { Archive, CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { assetMaxBytes, assetMimeType, isAllowedAssetMimeType } from "@/lib/asset-formats";
import { formatBytes } from "@/lib/format";
import {
  htmlToMarkdown,
  type ImportPreview,
  type ImportSource,
  importText,
  normalizedImportPath,
  previewImportArchive,
  rewriteImportedLinks,
} from "@/lib/import-archive";
import { parseDelimited, sheetImportUpdates } from "@/lib/sheet-csv";

type Step = "upload" | "preview" | "importing" | "report";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sourceLabel(source: ImportSource): string {
  if (source === "notion") return "Notion";
  if (source === "confluence") return "Confluence";
  return "Google Docs";
}

export function ImportDialog({ projectId }: { projectId: string }) {
  const pid = projectId as Id<"projects">;
  const usage = useQuery(api.documents.usage, { projectId: pid });
  const nodes = useQuery(api.documents.listByProject, { projectId: pid });
  const createFolder = useMutation(api.documents.createFolder);
  const importDocuments = useMutation(api.documents.importDocuments);
  const importSheet = useMutation(api.documents.importSheet);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const validateAssetUpload = useAction(api.documents.validateAssetUpload);
  const createAsset = useMutation(api.documents.createAsset);
  const createJob = useMutation(api.imports.createJob);
  const startJob = useMutation(api.imports.start);
  const recordProgress = useMutation(api.imports.progress);
  const finishJob = useMutation(api.imports.finish);
  const failJob = useMutation(api.imports.fail);
  const cancelJob = useMutation(api.imports.cancel);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  const [source, setSource] = useState<ImportSource>("notion");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [processed, setProcessed] = useState(0);
  const [report, setReport] = useState<string[]>([]);
  const [jobId, setJobId] = useState<Id<"importJobs"> | null>(null);
  const cancelled = useRef(false);

  const reset = () => {
    setStep("upload");
    setPreview(null);
    setFileName("");
    setProcessed(0);
    setReport([]);
    setJobId(null);
    cancelled.current = false;
  };

  const chooseFile = async (file: File) => {
    try {
      setFileName(file.name);
      const next = await previewImportArchive(file);
      setPreview(next);
      setStep("preview");
    } catch (error) {
      notify.error("Archive rejected", {
        description:
          error instanceof Error ? error.message.replaceAll("-", " ") : "Invalid archive",
      });
    }
  };

  const runImport = async () => {
    if (!preview || !usage) return;
    if (usage.usedBytes + preview.totalUncompressedBytes > usage.maxSizeBytes) {
      notify.error("Project storage limit exceeded", {
        description: `This archive declares ${formatBytes(preview.totalUncompressedBytes)} before conversion.`,
      });
      return;
    }
    cancelled.current = false;
    setStep("importing");
    const manifest = JSON.stringify({
      fileName,
      counts: preview.counts,
      bytes: preview.totalUncompressedBytes,
      warnings: preview.warnings.slice(0, 100),
    });
    let activeJob: Id<"importJobs"> | null = null;
    const createdIds: Id<"documents">[] = [];
    const results: string[] = [];
    try {
      activeJob = await createJob({
        projectId: pid,
        source,
        manifest,
        totalEntries: preview.entries.length,
      });
      setJobId(activeJob);
      await startJob({ jobId: activeJob });
      const existingNames = new Set(
        (nodes ?? [])
          .filter((node) => node.parentId === null)
          .map((node) => node.name.toLowerCase()),
      );
      const baseName = `${sourceLabel(source)} import ${new Date().toISOString().slice(0, 10)}`;
      let rootName = baseName;
      for (let suffix = 2; existingNames.has(rootName.toLowerCase()); suffix += 1)
        rootName = `${baseName} ${suffix}`;
      const rootId = await createFolder({ projectId: pid, parentId: null, name: rootName });
      createdIds.push(rootId);
      const folders = new Map<string, Id<"documents"> | null>([["", rootId]]);
      const paths = preview.entries.map((entry) => normalizedImportPath(entry.path, source));
      const folderPaths = [
        ...new Set(
          paths.flatMap((path) => {
            const parts = path.split("/").slice(0, -1);
            return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
          }),
        ),
      ].sort((left, right) => left.split("/").length - right.split("/").length);
      for (const folderPath of folderPaths) {
        if (cancelled.current) throw new Error("cancelled");
        const parts = folderPath.split("/");
        const parentPath = parts.slice(0, -1).join("/");
        const folderId = await createFolder({
          projectId: pid,
          parentId: folders.get(parentPath) ?? rootId,
          name: parts.at(-1) ?? "Imported",
        });
        folders.set(folderPath, folderId);
        createdIds.push(folderId);
      }
      await recordProgress({
        jobId: activeJob,
        processedEntries: 0,
        createdDocumentIds: createdIds,
      });
      for (const [index, entry] of preview.entries.entries()) {
        if (cancelled.current) throw new Error("cancelled");
        const path = paths[index] ?? entry.path;
        const parts = path.split("/");
        const rawName = parts.pop() ?? "Imported";
        const parentId = folders.get(parts.join("/")) ?? rootId;
        const added: Id<"documents">[] = [];
        if (entry.kind === "markdown" || entry.kind === "html") {
          const markdown = rewriteImportedLinks(
            entry.kind === "html" ? htmlToMarkdown(importText(entry)) : importText(entry),
            source,
          );
          const name = rawName.replace(/\.(?:html?|markdown|txt)$/i, ".md");
          added.push(
            ...(await importDocuments({
              projectId: pid,
              parentId,
              files: [{ name, content: markdown }],
            })),
          );
          results.push(`Converted ${entry.path} → ${name}`);
        } else if (entry.kind === "csv") {
          const delimiter = rawName.toLowerCase().endsWith(".tsv") ? "\t" : ",";
          const values = parseDelimited(importText(entry), delimiter);
          const updates = sheetImportUpdates(values).map(arrayBuffer);
          added.push(
            await importSheet({
              projectId: pid,
              parentId,
              name: rawName.replace(/\.(?:csv|tsv)$/i, ".sheet"),
              updates,
            }),
          );
          results.push(`Converted ${entry.path} → spreadsheet`);
        } else if (entry.kind === "asset") {
          const assetFile = new File([arrayBuffer(entry.bytes)], rawName);
          const mimeType = assetMimeType(assetFile);
          const limit = assetMaxBytes(mimeType);
          if (!isAllowedAssetMimeType(mimeType) || limit === null || assetFile.size > limit) {
            results.push(`Skipped ${entry.path}: unsupported or over its file-size limit`);
          } else {
            const uploadUrl = await generateUploadUrl({ projectId: pid });
            const response = await fetch(uploadUrl, {
              method: "POST",
              headers: { "Content-Type": mimeType },
              body: assetFile,
            });
            if (!response.ok) throw new Error("asset-upload-failed");
            const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
            await validateAssetUpload({ projectId: pid, storageId });
            added.push(
              (await createAsset({ projectId: pid, parentId, name: rawName, storageId })).id,
            );
            results.push(`Imported ${entry.path} → attachment`);
          }
        } else {
          results.push(`Skipped ${entry.path}: unsupported entry`);
        }
        createdIds.push(...added);
        setProcessed(index + 1);
        await recordProgress({
          jobId: activeJob,
          processedEntries: index + 1,
          createdDocumentIds: added,
        });
      }
      const reportContent = [
        `# ${sourceLabel(source)} import report`,
        "",
        `Archive: ${fileName}`,
        `Imported: ${results.filter((row) => !row.startsWith("Skipped")).length}`,
        `Skipped: ${results.filter((row) => row.startsWith("Skipped")).length}`,
        "",
        ...results.map((row) => `- ${row}`),
      ].join("\n");
      const [reportId] = await importDocuments({
        projectId: pid,
        parentId: rootId,
        files: [{ name: "Import report.md", content: reportContent }],
      });
      await finishJob({ jobId: activeJob, reportDocumentId: reportId });
      setReport(results);
      setStep("report");
      notify.success("Import completed", {
        description: `${preview.entries.length} entries processed.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "import-failed";
      if (activeJob) {
        if (message === "cancelled") await cancelJob({ jobId: activeJob });
        else await failJob({ jobId: activeJob, error: message });
      }
      if (message === "cancelled") {
        notify.info("Import cancelled", { description: "Created items were moved to trash." });
        reset();
      } else {
        setReport([...results, `Stopped: ${message}`]);
        setStep("report");
        notify.error("Import stopped", {
          description:
            "Partial results are listed in the report and can be cancelled from this dialog.",
        });
      }
    }
  };

  return (
    <>
      <Button variant="secondary" className="w-full sm:w-40" onClick={() => setOpen(true)}>
        <Archive className="size-4" aria-hidden="true" /> Import archive
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (step !== "importing") {
            setOpen(false);
            reset();
          }
        }}
        title="Import workspace archive"
        description="Preview and import a bounded ZIP export from Notion, Confluence, or Google Docs."
        mobileSheet
        className="max-w-2xl"
      >
        <div className="thin-scrollbar overflow-y-auto p-5">
          <ol className="mb-5 grid grid-cols-4 gap-1" aria-label="Import progress">
            {["Upload", "Preview", "Import", "Report"].map((label, index) => (
              <li
                key={label}
                className={`rounded-xs px-2 py-2 text-center font-mono text-[10px] uppercase tracking-wider ${index <= ["upload", "preview", "importing", "report"].indexOf(step) ? "bg-accent/10 text-foreground" : "bg-foreground/[0.03] text-muted-foreground"}`}
              >
                {label}
              </li>
            ))}
          </ol>
          {step === "upload" ? (
            <div className="grid gap-4">
              <label className="grid gap-2 text-sm">
                Source
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value as ImportSource)}
                  className="h-11 rounded-sm border border-hairline bg-background px-3"
                >
                  <option value="notion">Notion</option>
                  <option value="confluence">Confluence</option>
                  <option value="google">Google Docs</option>
                </select>
              </label>
              <label className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg border border-hairline border-dashed p-6 text-center hover:bg-foreground/[0.03]">
                <Upload className="size-7 text-muted-foreground" aria-hidden="true" />
                <span className="mt-3 font-medium text-sm">Choose a ZIP export</span>
                <span className="mt-1 text-muted-foreground text-xs">
                  Maximum 50 MB compressed, 1,000 entries, 200 MB expanded
                </span>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void chooseFile(file);
                  }}
                />
              </label>
            </div>
          ) : null}
          {step === "preview" && preview ? (
            <div>
              <h3 className="font-serif text-xl">Ready to import {fileName}</h3>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {Object.entries(preview.counts).map(([kind, count]) => (
                  <div key={kind} className="rounded-sm border border-hairline p-3">
                    <p className="font-mono text-xl">{count}</p>
                    <p className="text-muted-foreground text-xs capitalize">{kind}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-muted-foreground text-sm">
                Expanded size: {formatBytes(preview.totalUncompressedBytes)}. Unsupported entries
                remain visible in the final report.
              </p>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={reset}>
                  Back
                </Button>
                <Button onClick={() => void runImport()}>Start import</Button>
              </div>
            </div>
          ) : null}
          {step === "importing" && preview ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto size-8 animate-spin text-accent" aria-hidden="true" />
              <h3 className="mt-4 font-serif text-xl">
                Importing {processed} of {preview.entries.length}
              </h3>
              <div
                className="mx-auto mt-4 h-2 max-w-md overflow-hidden rounded-full bg-foreground/[0.08]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={preview.entries.length}
                aria-valuenow={processed}
              >
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${(processed / preview.entries.length) * 100}%` }}
                />
              </div>
              <Button
                variant="destructive"
                className="mt-6"
                onClick={() => {
                  cancelled.current = true;
                }}
              >
                <X className="size-4" aria-hidden="true" />
                Cancel import
              </Button>
            </div>
          ) : null}
          {step === "report" ? (
            <div>
              <CheckCircle2 className="size-8 text-success" aria-hidden="true" />
              <h3 className="mt-3 font-serif text-xl">Import report</h3>
              <ul className="mt-4 max-h-80 overflow-y-auto rounded-sm border border-hairline p-3 text-xs">
                {report.map((row) => (
                  <li key={row} className="py-1">
                    {row}
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex justify-end gap-2">
                {jobId ? (
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      await cancelJob({ jobId });
                      notify.info("Imported items moved to trash");
                      setOpen(false);
                      reset();
                    }}
                  >
                    Undo import
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    setOpen(false);
                    reset();
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
