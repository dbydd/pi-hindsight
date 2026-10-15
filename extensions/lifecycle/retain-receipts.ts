import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { redactSecrets } from "../utils/sanitize.js";
import { projectStateDir } from "../config/paths.js";
import type { RetainOutcome, UpdateMode } from "../types.js";

export interface RetainReceipt {
  createdAt: string;
  bankId: string;
  documentId: string;
  queueJobId: string;
  updateMode: UpdateMode;
  source: "tool" | "import" | "queue";
  context: string;
  tags: string[];
  outcome?: RetainOutcome;
}

export interface RetainReceiptHistory {
  version: 1;
  receipts: RetainReceipt[];
}

const MAX_RECEIPTS = 50;
const MAX_RECEIPT_CONTEXT_CHARS = 1000;

export function retainReceiptsPath(cwd: string): string {
  return resolve(projectStateDir(cwd), "retain-receipts.json");
}

function emptyHistory(): RetainReceiptHistory {
  return { version: 1, receipts: [] };
}

export async function readRetainReceipts(path: string): Promise<RetainReceiptHistory> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RetainReceiptHistory>;
    if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) return emptyHistory();
    return { version: 1, receipts: parsed.receipts.filter(isRetainReceipt).slice(0, MAX_RECEIPTS) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHistory();
    return emptyHistory();
  }
}

function isRetainReceipt(value: unknown): value is RetainReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.createdAt === "string" &&
    typeof receipt.bankId === "string" &&
    typeof receipt.documentId === "string" &&
    typeof receipt.queueJobId === "string" &&
    (receipt.updateMode === "append" || receipt.updateMode === "replace") &&
    (receipt.source === "tool" || receipt.source === "import" || receipt.source === "queue") &&
    typeof receipt.context === "string" &&
    Array.isArray(receipt.tags) &&
    receipt.tags.every((tag) => typeof tag === "string")
  );
}

type ReceiptInput = Omit<RetainReceipt, "createdAt"> & { createdAt?: string };
type ReceiptOptions = { redactSecrets?: boolean; maxContextChars?: number };

function receiptContext(context: string, options: ReceiptOptions): string {
  const redacted = options.redactSecrets === false ? context : redactSecrets(context);
  const maxChars = options.maxContextChars ?? MAX_RECEIPT_CONTEXT_CHARS;
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…[truncated]`;
}

function buildReceipt(receipt: ReceiptInput, options: ReceiptOptions): RetainReceipt {
  return {
    createdAt: receipt.createdAt ?? new Date().toISOString(),
    bankId: receipt.bankId,
    documentId: receipt.documentId,
    queueJobId: receipt.queueJobId,
    updateMode: receipt.updateMode,
    source: receipt.source,
    context: receiptContext(receipt.context, options),
    tags: receipt.tags,
    ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
  };
}

function mergeReceipt(receipts: RetainReceipt[], next: RetainReceipt): RetainReceipt[] {
  return [
    next,
    ...receipts.filter(
      (existing) => existing.documentId !== next.documentId || existing.bankId !== next.bankId,
    ),
  ];
}

async function writeReceiptHistory(
  cwd: string,
  receipts: RetainReceipt[],
): Promise<RetainReceiptHistory> {
  const path = retainReceiptsPath(cwd);
  const history = { version: 1 as const, receipts: receipts.slice(0, MAX_RECEIPTS) };
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
  return history;
}

export async function appendRetainReceipt(
  cwd: string,
  receipt: ReceiptInput,
  options: ReceiptOptions = {},
): Promise<RetainReceiptHistory> {
  const current = await readRetainReceipts(retainReceiptsPath(cwd));
  return writeReceiptHistory(cwd, mergeReceipt(current.receipts, buildReceipt(receipt, options)));
}

export async function appendRetainReceipts(
  cwd: string,
  receiptInputs: ReceiptInput[],
  options: ReceiptOptions = {},
): Promise<RetainReceiptHistory> {
  if (receiptInputs.length === 0) return readRetainReceipts(retainReceiptsPath(cwd));
  const current = await readRetainReceipts(retainReceiptsPath(cwd));
  let receipts = current.receipts;
  for (const input of receiptInputs)
    receipts = mergeReceipt(receipts, buildReceipt(input, options));
  return writeReceiptHistory(cwd, receipts);
}

export async function listRetainReceipts(cwd: string, limit = 10): Promise<RetainReceipt[]> {
  const history = await readRetainReceipts(retainReceiptsPath(cwd));
  return history.receipts.slice(0, Math.max(0, limit));
}
