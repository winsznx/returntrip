import { formatCsv } from '../csv/write.ts';
import type { LedgerStore } from '../db.ts';
import { formatCents } from '../domain/money.ts';
import { PAYMENT_CSV_COLUMNS } from '../domain/payment.ts';

/** Same stored rows always produce the same bytes: insertion order, fixed header, no BOM. */
export function exportPaymentsCsv(store: LedgerStore, workspaceId: number): string {
  const records: string[][] = [[...PAYMENT_CSV_COLUMNS]];
  for (const payment of store.allPayments(workspaceId)) {
    records.push([
      payment.voucherNumber ?? '',
      formatCents(payment.amountCents),
      payment.checkDate,
      payment.departmentName ?? '',
      payment.contractNumber,
      payment.vendorName,
    ]);
  }
  return formatCsv(records);
}

export function exportFileName(workspaceSlug: string): string {
  return `${workspaceSlug}-payments.csv`;
}
